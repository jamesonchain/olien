// The contracts this service was written against, checked by what is at their addresses.
//
// The deployment file says where Olien is on this chain, and until now the service
// believed it for as long as it ran. Whoever can change that file, or the chain behind
// an RPC, could point the service at a factory of their own: accounts would be created
// there, proposals built for it, and everything would look as it should. So at boot the
// four addresses are held to the ones v1 was deployed at, and the code at each to the
// hash of what v1 deploys. A difference stops the service rather than starting it
// against the wrong thing.
//
// The reference is deployments/v1/creation.json, compiled into the binary: the same
// file the deploy script sends from and the contracts' own test holds to the source.

use alloy::primitives::{Address, B256};
use serde::Deserialize;
use std::sync::OnceLock;

use crate::olien::{OlienClient, OlienDeployment, OlienV2Deployment};

const BOOK: &str = include_str!("../../deployments/v1/creation.json");
const BOOK_V2: &str = include_str!("../../deployments/v2/creation.json");

#[derive(Debug, Deserialize)]
struct Entry {
    address: Address,
    #[serde(rename = "runtimeCodeHash")]
    runtime_code_hash: B256,
}

#[derive(Debug, Deserialize)]
struct Contracts {
    verifier: Entry,
    #[serde(rename = "subAccountImplementation")]
    sub_account_implementation: Entry,
    implementation: Entry,
    factory: Entry,
}

#[derive(Debug, Deserialize)]
struct Book {
    #[serde(rename = "entryPoint")]
    entry_point: Address,
    #[serde(rename = "accountCodeHash")]
    account_code_hash: B256,
    contracts: Contracts,
}

fn book() -> &'static Book {
    static PARSED: OnceLock<Book> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(BOOK).expect("deployments/v1/creation.json is compiled in and must parse"))
}

#[derive(Debug, Deserialize)]
struct ContractsV2 {
    verifier: Entry,
    policy: Entry,
    implementation: Entry,
    factory: Entry,
}

#[derive(Debug, Deserialize)]
struct BookV2 {
    #[serde(rename = "entryPoint")]
    entry_point: Address,
    #[serde(rename = "accountCodeHash")]
    account_code_hash: B256,
    contracts: ContractsV2,
}

fn book_v2() -> &'static BookV2 {
    static PARSED: OnceLock<BookV2> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(BOOK_V2).expect("deployments/v2/creation.json is compiled in and must parse"))
}

/// The hash of v2's implementation code, which a `setImplementation` naming it must carry.
pub fn implementation_v2_code_hash() -> B256 {
    book_v2().contracts.implementation.runtime_code_hash
}

/// What must be on the chain for a deployment file's `olienV2` to be Olien v2. The
/// proxy is v1's, so an account on either implementation has the one code hash.
pub fn expected_v2(deployment: &OlienV2Deployment) -> Result<Vec<(&'static str, Address, B256)>, String> {
    let canonical = &book_v2().contracts;
    if book_v2().entry_point != book().entry_point || book_v2().account_code_hash != book().account_code_hash {
        return Err("the v2 book does not share v1's EntryPoint and proxy; it was not pinned by ops/pin-v2.sh".into());
    }
    let pairs = [
        ("v2 verifier", deployment.verifier, &canonical.verifier),
        ("policy contract", deployment.policy, &canonical.policy),
        ("v2 implementation", deployment.implementation, &canonical.implementation),
        ("v2 factory", deployment.factory, &canonical.factory),
    ];
    let mut out = Vec::with_capacity(pairs.len());
    for (name, given, entry) in pairs {
        if given != entry.address {
            return Err(format!("the deployment file names {given:#x} as the {name}; Olien v2's is {:#x}", entry.address));
        }
        out.push((name, given, entry.runtime_code_hash));
    }
    Ok(out)
}

/// The code hash of every account the v1 factory makes: one proxy, the same on every
/// chain. An address with other code is not an Olien that factory made.
pub fn account_code_hash() -> B256 {
    book().account_code_hash
}

/// What must be on the chain for this deployment to be Olien v1: each address with the
/// code hash expected there. An address that is not v1's is refused before the chain is
/// asked anything.
pub fn expected(deployment: &OlienDeployment) -> Result<Vec<(&'static str, Address, B256)>, String> {
    let canonical = &book().contracts;
    let pairs = [
        ("verifier", deployment.verifier, &canonical.verifier),
        ("sub-account implementation", deployment.sub_account_implementation, &canonical.sub_account_implementation),
        ("implementation", deployment.implementation, &canonical.implementation),
        ("factory", deployment.factory, &canonical.factory),
    ];
    if deployment.entry_point != book().entry_point {
        return Err(format!("the deployment file names {:#x} as the EntryPoint; Olien v1 is built against {:#x}", deployment.entry_point, book().entry_point));
    }
    let mut out = Vec::with_capacity(pairs.len());
    for (name, given, entry) in pairs {
        if given != entry.address {
            return Err(format!("the deployment file names {given:#x} as the {name}; Olien v1's is {:#x}", entry.address));
        }
        out.push((name, given, entry.runtime_code_hash));
    }
    Ok(out)
}

pub enum Verdict {
    Verified,
    /// The addresses or the code are not Olien v1. Definitive: do not serve.
    Mismatch(String),
    /// The chain could not be read. Says nothing either way; ask again.
    Unreachable(String),
}

pub enum VerdictV2 {
    Verified,
    /// None of v2's addresses has code: it has not been deployed here. Serve v1 only.
    NotThere,
    /// Some code is there and it is not v2's, or only part of v2 is. Do not serve.
    Mismatch(String),
    Unreachable(String),
}

/// Whether the chain carries v2 at the addresses the file names. Nothing at all is a
/// legitimate answer, since v2 is deployed after the service that knows of it.
pub async fn verify_v2(client: &OlienClient, deployment: &OlienV2Deployment) -> VerdictV2 {
    let wanted = match expected_v2(deployment) {
        Ok(wanted) => wanted,
        Err(reason) => return VerdictV2::Mismatch(reason),
    };
    let empty = alloy::primitives::keccak256([]);
    let mut present = 0;
    for (name, address, hash) in &wanted {
        match client.code_hash(*address).await {
            Ok(found) if found == *hash => present += 1,
            Ok(found) if found == empty => {}
            Ok(found) => return VerdictV2::Mismatch(format!("the code at the {name} {address:#x} hashes to {found:#x}; Olien v2's hashes to {hash:#x}")),
            Err(error) => return VerdictV2::Unreachable(format!("{error:#}")),
        }
    }
    match present {
        0 => VerdictV2::NotThere,
        n if n == wanted.len() => VerdictV2::Verified,
        n => VerdictV2::Mismatch(format!("{n} of v2's {} contracts are on the chain; a half deployment is not served", wanted.len())),
    }
}

pub async fn verify(client: &OlienClient) -> Verdict {
    let wanted = match expected(&client.deployment) {
        Ok(wanted) => wanted,
        Err(reason) => return Verdict::Mismatch(reason),
    };
    for (name, address, hash) in wanted {
        match client.code_hash(address).await {
            Ok(found) if found == hash => {}
            Ok(found) => return Verdict::Mismatch(format!("the code at the {name} {address:#x} hashes to {found:#x}; Olien v1's hashes to {hash:#x}")),
            Err(error) => return Verdict::Unreachable(format!("{error:#}")),
        }
    }
    Verdict::Verified
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Deployment;

    fn monad() -> OlienDeployment {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../deployments/10143.json")).expect("deployments/10143.json");
        serde_json::from_str::<Deployment>(&raw).expect("the Monad file parses").olien.expect("with an Olien")
    }

    #[test]
    fn the_monad_file_names_the_addresses_v1_was_deployed_at() {
        let wanted = expected(&monad()).expect("the Monad deployment is Olien v1");
        assert_eq!(wanted.len(), 4);
        assert!(wanted.iter().all(|(_, _, hash)| !hash.is_zero()));
    }

    // The file a person with access to the deployment could write: every address right
    // but the factory. Accounts would be created wherever that factory put them.
    #[test]
    fn a_deployment_file_naming_another_factory_is_refused() {
        let mut deployment = monad();
        deployment.factory = "0x06C66411DD49D96B55797416CD17a8E4bcC22c47".parse().unwrap();
        let refusal = expected(&deployment).unwrap_err();
        assert!(refusal.contains("as the factory"), "{refusal}");
    }

    #[test]
    fn another_entry_point_is_refused() {
        let mut deployment = monad();
        deployment.entry_point = Address::repeat_byte(0x11);
        assert!(expected(&deployment).unwrap_err().contains("EntryPoint"));
    }

    #[test]
    fn an_account_has_one_code_hash() {
        assert!(!account_code_hash().is_zero());
    }

    fn monad_v2() -> OlienV2Deployment {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../deployments/10143.json")).expect("deployments/10143.json");
        serde_json::from_str::<Deployment>(&raw).expect("the Monad file parses").olien_v2.expect("with an Olien v2")
    }

    #[test]
    fn the_monad_file_names_the_addresses_v2_is_pinned_to() {
        let wanted = expected_v2(&monad_v2()).expect("the Monad v2 deployment is Olien v2");
        assert_eq!(wanted.len(), 4);
        assert!(wanted.iter().all(|(_, _, hash)| !hash.is_zero()));
        assert_eq!(implementation_v2_code_hash(), wanted[2].2);
    }

    #[test]
    fn a_v2_file_naming_another_policy_contract_is_refused() {
        let mut deployment = monad_v2();
        deployment.policy = Address::repeat_byte(0x22);
        assert!(expected_v2(&deployment).unwrap_err().contains("policy contract"));
    }
}
