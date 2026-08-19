# NutFT trading-card demo

**Status:** draft

**Scope:** a trading-card application profile of NUT-31

## 1. Purpose

The demo represents collectible cards as NutFT proofs. Each proof represents
one card and has `amount=1`. Wallets may group identical cards for display, but
the underlying proofs remain separate.

The mint may know the card identity, catalog metadata, issuance, and trading
volume. P2BK may reduce linkability to the recipient's long-lived public key;
it does not hide the card from the mint. Card-blinded transfers and
zero-knowledge proofs are out of scope.

## 2. NUT-31 profile

The demo follows NUT-31. Each card proof uses:

```text
unit   = collection_id
amount = 1
```

For this demo, `asset_id` is the card identifier. The NutFT asset reference
contains only:

```json
{
  "collection_id": "<collection-identifier>",
  "asset_id": "<card-identifier>",
  "catalog_uri": "<immutable-catalog-location>"
}
```

The proof's NutFT secret contains the `asset_binding` derived from this
reference as defined by NUT-31. Game identifiers, card properties, artwork,
definition hashes, and Blossom hashes belong in the catalog, not the token.
Cashu keyset identifiers and P2PK/P2BK spending conditions remain ordinary
Cashu proof data and are not part of the asset reference or binding.

## 3. Card catalog

The demo uses an immutable signed catalog manifest located by `catalog_uri`.
The manifest identifies its `collection_id`, schema version, issuer key, and
assets. Each asset entry is keyed by `asset_id` and may contain:

- name, rarity, expansion, type, and game properties;
- a Blossom object reference and content hash;
- artwork and display metadata.

The issuer signs the catalog manifest, not each NutFT proof. The mint validates
the catalog according to the demo policy before issuance. Wallets verify the
catalog signature and Blossom content hash before displaying a card.

A changed catalog creates a new immutable manifest and collection identifier.

## 4. Issuance

The store sells a default deck or booster, then requests one NutFT output per
card. Issuance follows NUT-04 and NUT-31.

For each output, the mint MUST:

1. validate `unit=collection_id` and `amount=1`;
2. validate the cleartext NutFT declaration accompanying `B_`;
3. verify that `asset_id` exists in the catalog at `catalog_uri`;
4. compute the expected `asset_binding` from the declaration;
5. sign the blinded message `B_`;
6. return a DLEQ proof when NUT-12 is supported.

The mint sees the asset reference but not the secret hidden behind `B_`. It
validates the revealed NutFT secret when the resulting proof is spent.

## 5. Wallet display

Before displaying a card as valid, the wallet verifies:

1. the Cashu proof and keyset;
2. `amount=1` and `unit=collection_id`;
3. the NutFT secret, asset reference, and `asset_binding`;
4. the spending condition, when used;
5. DLEQ, when present;
6. the catalog signature and Blossom content hash.

Display metadata is external application data. It does not replace or modify
the asset reference carried by the proof.

## 6. Trading

Trades may be negotiated outside the mint. Settlement uses one atomic
consume-and-issue operation:

```text
consume(old_proof, valid_owner_witness)
issue(new_proof, new_owner_destination)
```

The mint MUST validate the consumed proof and destination before marking the
old proof spent. The new proof MUST preserve the exact same asset reference and
`asset_binding`. If issuance fails, the old proof remains spendable.

The demo demonstrates a P2BK recipient destination when supported. P2BK hides
the recipient's long-lived public key from the mint but does not hide the card
identity or trading volume. Ordinary P2PK destinations may also be used.

A generic swap or other operation that consumes a NutFT proof and issues a new
proof without preserving its NutFT secret and `asset_binding` MUST be rejected.

## 7. Applets

The platform provides three applets:

- **Store:** sells default decks and boosters;
- **Deck builder:** reads verified wallet cards and creates decks;
- **Gameplay:** requests possession proofs and applies game rules.

Gameplay logic is not part of the token. Applets MUST treat catalog properties
as declarative data and MUST NOT execute arbitrary code from card metadata.

## 8. Acceptance criteria

The demo is complete when it demonstrates:

- one proof per card with `amount=1` and `unit=collection_id`;
- wallet display from a verified signed catalog and Blossom object;
- DLEQ verification when supported;
- P2BK recipient-key privacy;
- an atomic trade that preserves the exact `asset_binding`;
- rejection of a replacement that changes the asset reference;
- rejection of a second spend of the old proof;
- recovery of a completed trade after a lost response;
- no execution of arbitrary catalog-provided code.

## 9. Out of scope

- zero-knowledge card-identity hiding;
- fair or publicly verifiable booster randomness;
- fixed supply per card;
- a marketplace or escrow protocol;
- a universal game engine;
- production use with real money before independent security review.
