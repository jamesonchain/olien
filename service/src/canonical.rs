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

use crate::olien::{OlienClient, OlienDeployment};

const BOOK: &str = include_str!("../../deployments/v1/creation.json");

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
}
