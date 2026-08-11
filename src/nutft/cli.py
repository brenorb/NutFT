"""Command-line happy-path demonstration for NutFT."""

from collections import Counter

from .core import (
    Asset,
    AssetCatalog,
    BoosterPolicy,
    BoosterSlot,
    LocalMint,
    Wallet,
)


def main() -> None:
    catalog = AssetCatalog(
        [
            Asset("demo-cards", "black-lotus", "Black Lotus", "mythic"),
            Asset("demo-cards", "lightning-bolt", "Lightning Bolt", "rare"),
            Asset("demo-cards", "island", "Island", "common"),
        ]
    )
    mint = LocalMint(catalog)
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)

    policy = BoosterPolicy(
        policy_id="demo-v1",
        collection_id="demo-cards",
        slots=(
            BoosterSlot("rare", "rare", 1),
            BoosterSlot("common", "common", 2),
        ),
    )
    booster = alice.buy_booster(policy)
    cards = alice.open_booster(booster, policy)
    possession = alice.prove_possession(cards[0], b"nutft-demo")
    original = alice.mint("black-lotus")
    received = alice.transfer(original, bob)

    print("NutFT local demo")
    print(
        f"booster cards: {len(cards)} ({dict(Counter(card.asset.rarity for card in cards))})"
    )
    print(
        "possession proof valid: "
        f"{mint.verify_possession(cards[0], possession, b'nutft-demo')}"
    )
    print(f"asset transferred: {received.asset.name} ({received.asset.rarity})")
    print(f"original commitment: {original.commitment[:16]}…")
    print(f"received commitment: {received.commitment[:16]}…")
    print(f"old nullifier spent: {mint.is_spent(original.nullifier)}")
