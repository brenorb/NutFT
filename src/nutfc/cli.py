"""Command-line happy-path demonstration for NutFC."""

from .core import Asset, AssetCatalog, LocalMint, Wallet


def main() -> None:
    catalog = AssetCatalog(
        [Asset("demo-cards", "black-lotus", "Black Lotus", "mythic")]
    )
    mint = LocalMint(catalog)
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)

    original = alice.mint("black-lotus")
    received = alice.transfer(original, bob)

    print("NutFC local demo")
    print(f"asset: {received.asset.name} ({received.asset.rarity})")
    print(f"original commitment: {original.commitment[:16]}…")
    print(f"received commitment: {received.commitment[:16]}…")
    print(f"old nullifier spent: {mint.is_spent(original.nullifier)}")
