// The treasury's own rules about money, kept by the service.
//
// The account enforces who may approve and how many it takes. It has no view on how
// much, to whom or when: with the threshold's signatures a transfer of any size to any
// address runs in the block that authorizes it. Every large multisig theft of the last
// years was a quorum that had been fooled, and the one thing that would have helped
// each of them was time, or one more pair of eyes on the unusual payment.
//
// These rules are that, as far as a service can provide it. A payment above a tier
// needs more approvals than the threshold. A payment to an address the members have
// not vouched for waits, and one they vouched for only today waits a little too. A
// payment outside the hours the team works waits for them.
//
// They are soft. Members holding the threshold's signatures can execute on the chain
// without this service, so nothing here is a wall, and the console says so beside
// every one of them. It is the wall's blueprint, running before the account has one.
// To keep the blueprint honest it behaves as the on-chain rule will: tightening takes
// effect at once, and loosening waits the account's own config delay, during which any
// member can cancel it.

use alloy::primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const DAY: u64 = 86_400;
const MAX_TIERS: usize = 8;
const MAX_NEW_DESTINATION_DELAY: u64 = 30 * DAY;
const MINUTES_IN_DAY: u16 = 1_440;
const MINUTES_IN_WEEK: i64 = 7 * 1_440;

/// Above this much in one transaction, this many approvals. Amounts are in the token's
/// smallest unit, as a decimal string, like every other amount the service speaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub above: String,
    pub approvals: u16,
}

/// When payments may run: on these days, between these minutes of the day, at this
/// fixed offset from UTC. A fixed offset and not a named zone, so the rule means the
/// same thing on every machine that evaluates it and does not move twice a year.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hours {
    /// 0 is Sunday.
    pub days: Vec<u8>,
    pub start: u16,
    pub end: u16,
    pub utc_offset: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    pub tiers: Vec<Tier>,
    pub require_known_destination: bool,
    /// How long an address must have been in the address book before it counts as known.
    pub new_destination_delay: u64,
    pub hours: Option<Hours>,
}

fn amount_of(tier: &Tier) -> Result<U256, String> {
    U256::from_str_radix(tier.above.trim(), 10).map_err(|_| format!("{} is not an amount", tier.above))
}

impl Policy {
    /// The policy as it may be stored, or the reason it may not.
    pub fn checked(self) -> Result<Policy, String> {
        if self.tiers.len() > MAX_TIERS {
            return Err(format!("at most {MAX_TIERS} tiers"));
        }
        let mut last: Option<(U256, u16)> = None;
        for tier in &self.tiers {
            let above = amount_of(tier)?;
            if tier.approvals == 0 || tier.approvals > 32 {
                return Err("a tier asks for between 1 and 32 approvals".into());
            }
            if let Some((previous, approvals)) = last {
                if above <= previous {
                    return Err("tiers go from the smallest amount to the largest, each one once".into());
                }
                if tier.approvals < approvals {
                    return Err("a larger amount cannot need fewer approvals than a smaller one".into());
                }
            }
            last = Some((above, tier.approvals));
        }
        if self.new_destination_delay > MAX_NEW_DESTINATION_DELAY {
            return Err("a new destination waits at most 30 days".into());
        }
        if let Some(hours) = &self.hours {
            let mut seen = HashSet::new();
            if hours.days.is_empty() || hours.days.iter().any(|day| *day > 6 || !seen.insert(*day)) {
                return Err("hours name between one and seven different days, 0 for Sunday to 6 for Saturday".into());
            }
            if hours.start >= hours.end || hours.end > MINUTES_IN_DAY {
                return Err("hours open before they close, within one day".into());
            }
            if hours.utc_offset.abs() > 14 * 60 {
                return Err("the offset from UTC is at most 14 hours".into());
            }
        }
        Ok(self)
    }

    /// The approvals the tiers ask for an amount. A call the service cannot read has no
    /// amount to hold against a tier, so it is held to the highest one.
    pub fn tier_for(&self, amount: U256, unreadable: bool) -> u16 {
        self.tiers
            .iter()
            .filter(|tier| unreadable || amount_of(tier).is_ok_and(|above| amount > above))
            .map(|tier| tier.approvals)
            .max()
            .unwrap_or(0)
    }

    fn allows_minute(&self, utc_minute_of_week: i64) -> bool {
        let Some(hours) = &self.hours else { return true };
        let local = (utc_minute_of_week + hours.utc_offset as i64).rem_euclid(MINUTES_IN_WEEK);
        let day = (local / MINUTES_IN_DAY as i64) as u8;
        let minute = (local % MINUTES_IN_DAY as i64) as u16;
        hours.days.contains(&day) && minute >= hours.start && minute < hours.end
    }

    /// None while payments may run; otherwise the moment they next may.
    pub fn opens_at(&self, now: u64) -> Option<u64> {
        self.hours.as_ref()?;
        // 1 January 1970 was a Thursday, day 4 of a week that starts on Sunday.
        let minute_of_week = |unix: u64| ((unix / 60) as i64 + 4 * MINUTES_IN_DAY as i64).rem_euclid(MINUTES_IN_WEEK);
        if self.allows_minute(minute_of_week(now)) {
            return None;
        }
        let start_of_minute = now - now % 60;
        (1..=MINUTES_IN_WEEK as u64).map(|ahead| start_of_minute + ahead * 60).find(|at| self.allows_minute(minute_of_week(*at)))
    }
}

/// The ways `new` lets through something `old` would have held. Empty means the change
/// only tightens, and may take effect at once.
pub fn loosens(old: &Policy, new: &Policy) -> Vec<&'static str> {
    let mut out = Vec::new();
    // Both tier lists are step functions of the amount, so comparing them just above
    // every step of either one compares them everywhere.
    let steps: Vec<U256> = old.tiers.iter().chain(&new.tiers).filter_map(|tier| amount_of(tier).ok()).collect();
    let fewer_approvals = steps.iter().any(|step| new.tier_for(step.saturating_add(U256::from(1u64)), false) < old.tier_for(step.saturating_add(U256::from(1u64)), false))
        || new.tier_for(U256::ZERO, true) < old.tier_for(U256::ZERO, true);
    if fewer_approvals {
        out.push("it asks for fewer approvals for some amount");
    }
    if old.require_known_destination && !new.require_known_destination {
        out.push("it stops requiring a known destination");
    }
    if old.require_known_destination && new.require_known_destination && new.new_destination_delay < old.new_destination_delay {
        out.push("it shortens the wait for a new destination");
    }
    if (0..MINUTES_IN_WEEK).any(|minute| new.allows_minute(minute) && !old.allows_minute(minute)) {
        out.push("it widens the hours payments may run");
    }
    out
}

/// What a proposal, or a cheque, would do, as far as the rules care.
pub struct Facts<'a> {
    /// Each payment in it: the recipient and the amount.
    pub payments: &'a [(Address, U256)],
    /// The target of each call that is neither a payment nor a call to the account itself.
    pub unreadable: &'a [Address],
    pub approvals: i64,
    pub approvers: i64,
    pub threshold: i64,
    pub now: u64,
    /// The address book's signed entries, each with when its signer said it was added.
    pub known: &'a HashMap<Address, u64>,
    /// The account's own addresses: itself and its sub-accounts. Always known.
    pub internal: &'a HashSet<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftRule {
    pub rule: &'static str,
    pub text: String,
    /// When the rule stops holding by itself, where it does.
    pub until: Option<u64>,
}

/// The approvals this needs: the account's threshold, or more where a tier asks, and
/// never more than there are approvers. A soft rule that nobody could ever satisfy
/// would lock a treasury that the chain itself still lets act, which helps nobody.
pub fn required_approvals(policy: &Policy, facts: &Facts) -> i64 {
    if facts.payments.is_empty() && facts.unreadable.is_empty() {
        return facts.threshold;
    }
    let total = facts.payments.iter().fold(U256::ZERO, |sum, (_, amount)| sum.saturating_add(*amount));
    let tier = policy.tier_for(total, !facts.unreadable.is_empty()) as i64;
    facts.threshold.max(tier.min(facts.approvers.max(1)))
}

/// The rules still holding this back. Empty means the policy has nothing against it.
/// A change to the account's own rules is not money moving, and the chain already
/// delays it, so it is never held here.
pub fn evaluate(policy: &Policy, facts: &Facts) -> Vec<SoftRule> {
    let mut out = Vec::new();
    if facts.payments.is_empty() && facts.unreadable.is_empty() {
        return out;
    }
    let required = required_approvals(policy, facts);
    if facts.approvals < required {
        out.push(SoftRule {
            rule: "approvals",
            text: format!("Treasury policy asks for {required} approvals for this; it has {}.", facts.approvals),
            until: None,
        });
    }
    if policy.require_known_destination {
        let mut seen = HashSet::new();
        for destination in facts.payments.iter().map(|(to, _)| *to).chain(facts.unreadable.iter().copied()) {
            if facts.internal.contains(&destination) || !seen.insert(destination) {
                continue;
            }
            match facts.known.get(&destination) {
                None => out.push(SoftRule {
                    rule: "destination",
                    text: format!("{destination:#x} is not in the address book. Treasury policy pays only addresses a member has signed into it."),
                    until: None,
                }),
                Some(added) if added.saturating_add(policy.new_destination_delay) > facts.now => out.push(SoftRule {
                    rule: "destination",
                    text: format!("{destination:#x} is new to the address book. Treasury policy waits before paying a new destination, so that anyone who does not recognise it can remove it."),
                    until: Some(added.saturating_add(policy.new_destination_delay)),
                }),
                Some(_) => {}
            }
        }
    }
    if let Some(opens) = policy.opens_at(facts.now) {
        out.push(SoftRule { rule: "hours", text: "Outside the hours treasury policy lets payments run.".into(), until: Some(opens) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    const ACME: Address = address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    const ROUTER: Address = address!("000000000000000000000000000000000000dEaD");
    // Monday 5 October 2026, 12:00 UTC.
    const MONDAY_NOON: u64 = 1_791_201_600;

    fn tier(above: u64, approvals: u16) -> Tier {
        Tier { above: above.to_string(), approvals }
    }

    fn office_hours() -> Hours {
        Hours { days: vec![1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60, utc_offset: 60 }
    }

    struct Scene {
        payments: Vec<(Address, U256)>,
        unreadable: Vec<Address>,
        approvals: i64,
        known: HashMap<Address, u64>,
        internal: HashSet<Address>,
        now: u64,
    }

    impl Scene {
        fn paying(amount: u64) -> Scene {
            Scene { payments: vec![(ACME, U256::from(amount))], unreadable: vec![], approvals: 2, known: HashMap::new(), internal: HashSet::new(), now: MONDAY_NOON }
        }
        fn rules(&self, policy: &Policy) -> Vec<&'static str> {
            let facts = Facts { payments: &self.payments, unreadable: &self.unreadable, approvals: self.approvals, approvers: 3, threshold: 2, now: self.now, known: &self.known, internal: &self.internal };
            evaluate(policy, &facts).into_iter().map(|rule| rule.rule).collect()
        }
    }

    #[test]
    fn no_policy_holds_nothing() {
        assert!(Scene::paying(1_000_000_000_000).rules(&Policy::default()).is_empty());
    }

    #[test]
    fn a_tier_asks_for_more_than_the_threshold_only_above_its_amount() {
        let policy = Policy { tiers: vec![tier(25_000_000_000, 3)], ..Policy::default() };
        assert!(Scene::paying(25_000_000_000).rules(&policy).is_empty(), "at the line is not above it");
        assert_eq!(Scene::paying(25_000_000_001).rules(&policy), vec!["approvals"]);
        let mut signed_by_all = Scene::paying(25_000_000_001);
        signed_by_all.approvals = 3;
        assert!(signed_by_all.rules(&policy).is_empty());
    }

    #[test]
    fn a_batch_is_held_to_its_total() {
        let policy = Policy { tiers: vec![tier(1_000, 3)], ..Policy::default() };
        let mut batch = Scene::paying(600);
        batch.payments.push((ACME, U256::from(600u64)));
        assert_eq!(batch.rules(&policy), vec!["approvals"]);
    }

    // A tier can ask for more approvers than the account has. The chain would still let
    // the threshold act, so the soft rule stops at what the members can actually give.
    #[test]
    fn a_tier_never_asks_for_more_approvals_than_there_are_approvers() {
        let policy = Policy { tiers: vec![tier(0, 9)], ..Policy::default() };
        let scene = Scene::paying(1);
        let facts = Facts { payments: &scene.payments, unreadable: &[], approvals: 3, approvers: 3, threshold: 2, now: MONDAY_NOON, known: &scene.known, internal: &scene.internal };
        assert_eq!(required_approvals(&policy, &facts), 3);
        assert!(evaluate(&policy, &facts).is_empty());
    }

    #[test]
    fn a_call_that_cannot_be_read_is_held_to_the_highest_tier() {
        let policy = Policy { tiers: vec![tier(1_000_000, 2), tier(1_000_000_000_000, 3)], ..Policy::default() };
        let scene = Scene { payments: vec![], unreadable: vec![ROUTER], approvals: 2, known: HashMap::new(), internal: HashSet::new(), now: MONDAY_NOON };
        assert_eq!(scene.rules(&policy), vec!["approvals"]);
    }

    #[test]
    fn a_rule_change_is_not_money_and_is_never_held() {
        let policy = Policy { tiers: vec![tier(0, 3)], require_known_destination: true, new_destination_delay: DAY, hours: Some(office_hours()) };
        let scene = Scene { payments: vec![], unreadable: vec![], approvals: 2, known: HashMap::new(), internal: HashSet::new(), now: MONDAY_NOON + 12 * 3_600 };
        assert!(scene.rules(&policy).is_empty());
    }

    #[test]
    fn an_unknown_destination_waits_and_a_new_one_waits_out_its_delay() {
        let policy = Policy { require_known_destination: true, new_destination_delay: DAY, ..Policy::default() };
        assert_eq!(Scene::paying(1).rules(&policy), vec!["destination"]);

        let mut added_today = Scene::paying(1);
        added_today.known.insert(ACME, MONDAY_NOON - 3_600);
        let facts = Facts { payments: &added_today.payments, unreadable: &[], approvals: 2, approvers: 3, threshold: 2, now: MONDAY_NOON, known: &added_today.known, internal: &added_today.internal };
        let held = evaluate(&policy, &facts);
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].until, Some(MONDAY_NOON - 3_600 + DAY), "it says when the wait ends");

        let mut added_last_week = Scene::paying(1);
        added_last_week.known.insert(ACME, MONDAY_NOON - 7 * DAY);
        assert!(added_last_week.rules(&policy).is_empty());
    }

    #[test]
    fn the_accounts_own_addresses_are_always_known() {
        let policy = Policy { require_known_destination: true, ..Policy::default() };
        let mut to_a_sub_account = Scene::paying(1);
        to_a_sub_account.internal.insert(ACME);
        assert!(to_a_sub_account.rules(&policy).is_empty());
    }

    #[test]
    fn the_contract_behind_an_unreadable_call_must_be_known_too() {
        let policy = Policy { require_known_destination: true, ..Policy::default() };
        let scene = Scene { payments: vec![], unreadable: vec![ROUTER], approvals: 2, known: HashMap::new(), internal: HashSet::new(), now: MONDAY_NOON };
        assert_eq!(scene.rules(&policy), vec!["destination"]);
    }

    #[test]
    fn hours_hold_a_payment_until_they_open() {
        let policy = Policy { hours: Some(office_hours()), ..Policy::default() };
        // Noon UTC on a Monday is 13:00 at UTC+1: open.
        assert_eq!(policy.opens_at(MONDAY_NOON), None);
        // 20:00 UTC is 21:00 local: closed until 09:00 local on Tuesday, 08:00 UTC.
        let evening = MONDAY_NOON + 8 * 3_600;
        assert_eq!(policy.opens_at(evening), Some(MONDAY_NOON + 20 * 3_600));
        // Saturday noon UTC: closed until Monday 08:00 UTC.
        let saturday = MONDAY_NOON + 5 * DAY;
        assert_eq!(policy.opens_at(saturday), Some(MONDAY_NOON + 7 * DAY - 4 * 3_600));
        let mut late = Scene::paying(1);
        late.now = evening;
        assert_eq!(late.rules(&policy), vec!["hours"]);
    }

    #[test]
    fn tightening_is_told_from_loosening() {
        let base = Policy { tiers: vec![tier(1_000, 2), tier(25_000, 3)], require_known_destination: true, new_destination_delay: DAY, hours: Some(office_hours()) };
        assert!(loosens(&base, &base).is_empty());
        assert!(loosens(&Policy::default(), &base).is_empty(), "adding rules where there were none only tightens");

        let lower_line = Policy { tiers: vec![tier(500, 2), tier(10_000, 3)], ..base.clone() };
        assert!(loosens(&base, &lower_line).is_empty(), "asking for approvals from a smaller amount is tighter");
        let higher_line = Policy { tiers: vec![tier(1_000, 2), tier(50_000, 3)], ..base.clone() };
        assert_eq!(loosens(&base, &higher_line), vec!["it asks for fewer approvals for some amount"]);
        let no_tiers = Policy { tiers: vec![], ..base.clone() };
        assert_eq!(loosens(&base, &no_tiers), vec!["it asks for fewer approvals for some amount"]);

        let any_destination = Policy { require_known_destination: false, ..base.clone() };
        assert_eq!(loosens(&base, &any_destination), vec!["it stops requiring a known destination"]);
        let shorter_wait = Policy { new_destination_delay: 3_600, ..base.clone() };
        assert_eq!(loosens(&base, &shorter_wait), vec!["it shortens the wait for a new destination"]);

        let shorter_day = Policy { hours: Some(Hours { end: 17 * 60, ..office_hours() }), ..base.clone() };
        assert!(loosens(&base, &shorter_day).is_empty());
        let weekends = Policy { hours: Some(Hours { days: vec![0, 1, 2, 3, 4, 5, 6], ..office_hours() }), ..base.clone() };
        assert_eq!(loosens(&base, &weekends), vec!["it widens the hours payments may run"]);
        let always = Policy { hours: None, ..base.clone() };
        assert_eq!(loosens(&base, &always), vec!["it widens the hours payments may run"]);
        // The same wall clock in another zone is a different set of moments.
        let moved = Policy { hours: Some(Hours { utc_offset: 0, ..office_hours() }), ..base.clone() };
        assert_eq!(loosens(&base, &moved), vec!["it widens the hours payments may run"]);
    }

    #[test]
    fn a_policy_that_makes_no_sense_is_refused() {
        assert!(Policy { tiers: vec![tier(5, 2), tier(5, 3)], ..Policy::default() }.checked().is_err(), "the same amount twice");
        assert!(Policy { tiers: vec![tier(5, 3), tier(10, 2)], ..Policy::default() }.checked().is_err(), "more money, fewer approvals");
        assert!(Policy { tiers: vec![tier(5, 0)], ..Policy::default() }.checked().is_err());
        assert!(Policy { tiers: vec![Tier { above: "lots".into(), approvals: 2 }], ..Policy::default() }.checked().is_err());
        assert!(Policy { new_destination_delay: 31 * DAY, ..Policy::default() }.checked().is_err());
        assert!(Policy { hours: Some(Hours { days: vec![], ..office_hours() }), ..Policy::default() }.checked().is_err());
        assert!(Policy { hours: Some(Hours { start: 600, end: 600, ..office_hours() }), ..Policy::default() }.checked().is_err());
        assert!(Policy { hours: Some(Hours { days: vec![1, 1], ..office_hours() }), ..Policy::default() }.checked().is_err());
        assert!(Policy { tiers: vec![tier(1_000, 2), tier(25_000, 3)], require_known_destination: true, new_destination_delay: DAY, hours: Some(office_hours()) }.checked().is_ok());
    }

    #[test]
    fn a_policy_reads_and_writes_as_the_console_sends_it() {
        let text = r#"{"tiers":[{"above":"25000000000","approvals":3}],"requireKnownDestination":true,"newDestinationDelay":86400,"hours":{"days":[1,2,3,4,5],"start":540,"end":1080,"utcOffset":60}}"#;
        let policy: Policy = serde_json::from_str(text).unwrap();
        assert_eq!(policy.tiers[0].approvals, 3);
        assert_eq!(serde_json::to_string(&policy).unwrap(), text);
        assert_eq!(serde_json::from_str::<Policy>("{}").unwrap(), Policy::default(), "an empty object is no policy");
    }
}
