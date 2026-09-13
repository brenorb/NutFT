import * as E from "../vendor/ryuu/common";
import { setBase } from "../vendor/ryuu/base";
import data from "../../cards/pokemon-base.json";
export { E };
export const catalog = data;
const norm = (s: string) => s.replaceAll("♂", "male").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
export const definitions = new Map(data.map(c => {
  const card = setBase.find(x => norm(x.name) === norm(c.name));
  if (!card) throw new Error(`No programmed effect definition for ${c.name}`);
  return [c.id, card];
}));
E.CardManager.getInstance().defineSet(setBase);
export function validateDeck(ids: string[]) {
  if (!Array.isArray(ids) || ids.length !== 60 || ids.some(id => !definitions.has(id))) throw new Error("A Base Set deck needs 60 cards");
  if (!new E.DeckAnalyser(ids.map(id => definitions.get(id)!.fullName)).isValid()) throw new Error("Deck needs a Basic Pokémon and at most four copies per name (Basic Energy unlimited)");
}
export type Target = { player: number; slot: number; index: number };
export type Move = { seat: number; type: string; index?: number; name?: string; target?: Target; prompt?: number; result?: unknown };
export const own = (index = -1): Target => ({player: E.PlayerType.BOTTOM_PLAYER, slot: index < 0 ? E.SlotType.ACTIVE : E.SlotType.BENCH, index: Math.max(0, index)});
function rng(seed: string) {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return () => { x += 0x6D2B79F5; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const integer = (n: unknown, max: number) => Number.isInteger(n) && Number(n) >= 0 && Number(n) < max;
function unique(values: unknown[]) { return new Set(values.map(v => JSON.stringify(v))).size === values.length; }
export function targets(state: E.State, seat: number, prompt?: any) {
  const list: {value: Target; label: string; slot: E.PokemonSlot}[] = [];
  state.players.forEach(p => {
    const side = p.id === seat ? E.PlayerType.BOTTOM_PLAYER : E.PlayerType.TOP_PLAYER;
    if (prompt && prompt.playerType !== undefined && prompt.playerType !== E.PlayerType.ANY && prompt.playerType !== side) return;
    [p.active, ...p.bench].forEach((slot, i) => {
      const target = { player: side, slot: i ? E.SlotType.BENCH : E.SlotType.ACTIVE, index: Math.max(0, i - 1) };
      if (prompt?.slots && !prompt.slots.includes(target.slot)) return;
      if (slot.getPokemonCard()) list.push({value: target, label: `${side === E.PlayerType.BOTTOM_PLAYER ? "Your" : "Opponent"} ${i ? `bench ${i}` : "Active"}: ${slot.getPokemonCard()!.name}`, slot});
    });
  });
  return list;
}
export function choices(prompt: any, state: E.State) {
  switch (prompt.type) {
    case "Choose cards": return prompt.cards.cards.map((c: E.Card, i: number) => ({value: i, label: c.name})).filter((_: unknown, i: number) => !prompt.options.blocked.includes(i) && E.FilterUtils.match(prompt.cards.cards[i], prompt.filter));
    case "Choose energy": return prompt.energy.map((e: any, i: number) => ({value: i, label: `${e.card.name} × ${e.provideAmount}`}));
    case "Choose prize": return state.players.find(p => p.id === prompt.playerId)!.prizes.filter(p => p.cards.length).map((_, i) => ({value: i, label: `Prize ${i + 1}`}));
    case "Choose pokemon": return targets(state, prompt.playerId, prompt).filter(t => !prompt.options.blocked.some((b: Target) => JSON.stringify(b) === JSON.stringify(t.value)));
    case "Select": return prompt.values.map((label: string, value: number) => ({value, label: label.replaceAll("_", " ")}));
    case "Choose attack": return prompt.cards.flatMap((c: E.PokemonCard, index: number) => [...(prompt.options.enableAttack ? c.attacks : []), ...c.powers.filter(p => Object.entries(prompt.options.enableAbility).some(([k,v]) => v && (p as any)[k]))].map(a => ({value: {index, name: a.name}, label: `${c.name}: ${a.name}`}))).filter((x: any) => !prompt.options.blocked.some((b: any) => b.index === x.value.index && b.name === x.value.name));
    case "Order cards": return prompt.cards.cards.map((c: E.Card, i: number) => ({value: i, label: c.name}));
    case "Confirm": case "Show cards": return [{value: true, label: "Yes / continue"}, {value: false, label: "No"}];
    case "Alert": return [{value: true, label: "Continue"}];
    default: return [];
  }
}
// Validate decoded results AND their wire shape; upstream assumes a trusted UI.
export function decodeAnswer(prompt: any, raw: any, state: E.State) {
  if (raw === null) { if (!prompt.options?.allowCancel) throw new Error("This choice is required"); return null; }
  const options = choices(prompt, state);
  const has = (v: unknown) => options.some((o: any) => JSON.stringify(o.value) === JSON.stringify(v));
  const multi = ["Choose cards", "Choose energy", "Choose pokemon", "Choose prize", "Order cards"];
  if (multi.includes(prompt.type)) {
    if (!Array.isArray(raw) || !unique(raw) || !raw.every(has)) throw new Error("Choose distinct valid options");
  } else if (["Select", "Choose attack", "Confirm", "Alert", "Show cards"].includes(prompt.type)) {
    if (!has(raw)) throw new Error("Invalid choice");
  } else if (["Move energy", "Attach energy", "Move damage", "Put damage"].includes(prompt.type)) {
    if (!Array.isArray(raw) || raw.length > 120) throw new Error("Invalid transfers");
    const legal = targets(state, prompt.playerId, prompt);
    const target = (t: Target, blocked: Target[] = []) => {
      const item = legal.find(x => JSON.stringify(x.value) === JSON.stringify(t));
      if (!item || blocked.some(b => JSON.stringify(b) === JSON.stringify(t))) throw new Error("Invalid target");
      return item.slot;
    };
    const seen = new Set(); const changes = new Map<E.PokemonSlot, number>();
    if (raw.length < (prompt.options?.min || 0) || raw.length > (prompt.options?.max ?? 120)) throw new Error("Wrong number of transfers");
    for (const row of raw) {
      if (prompt.type === "Put damage") {
        const to = target(row.target, prompt.options.blocked);
        if (!Number.isInteger(row.damage) || row.damage < 0 || row.damage % 10) throw new Error("Invalid damage");
        changes.set(to, (changes.get(to) || 0) + row.damage); continue;
      }
      const to = target(row.to, prompt.options.blockedTo);
      if (prompt.type === "Move damage") {
        const from = target(row.from, prompt.options.blockedFrom);
        if (from === to) throw new Error("Choose another Pokémon");
        changes.set(from, (changes.get(from) || 0) - 10); changes.set(to, (changes.get(to) || 0) + 10);
      } else {
        const source = prompt.type === "Attach energy" ? prompt.cardList : target(row.from, prompt.options.blockedFrom).energies;
        if (!integer(row.index, source.cards.length)) throw new Error("Invalid Energy");
        const card = source.cards[row.index];
        if (seen.has(card)) throw new Error("Energy selected twice"); seen.add(card);
        if (prompt.options.blockedMap?.some((b: any) => JSON.stringify(b.source) === JSON.stringify(row.from) && b.blocked.includes(row.index))) throw new Error("Blocked Energy");
      }
    }
    for (const [slot, change] of changes) {
      const limit = prompt.maxAllowedDamage?.find((x: any) => target(x.target) === slot)?.damage;
      if (slot.damage + change < 0 || (limit !== undefined && (prompt.type === 'Move damage' ? slot.damage + change : change) > limit)) throw new Error("Damage exceeds allowed amount");
    }
  } else throw new Error(`Unsupported prompt: ${prompt.type}`);
  const decoded = prompt.decode(raw, state);
  if (!prompt.validate(decoded, state)) throw new Error("The card effect does not allow that choice");
  return decoded;
}
export class Game {
  store: E.Store;
  random: () => number;
  constructor(decks: string[][], seed: string, moves: Move[] = []) {
    decks.forEach(validateDeck);
    this.random = rng(seed);
    this.store = new E.Store({onStateChange() {}});
    decks.forEach((ids, i) => this.store.dispatch(new E.AddPlayerAction(i + 1, `Player ${i + 1}`, ids.map(id => definitions.get(id)!.fullName))));
    this.automatic();
    moves.forEach(m => this.apply(m));
  }
  get state() { return this.store.state; }
  automatic() {
    for (let i = 0; i < 1000; i++) {
      const prompt = this.state.prompts.find(p => p.result === undefined && ["Shuffle deck", "Coin flip"].includes(p.type));
      if (!prompt) return;
      let result: boolean | number[];
      if (prompt.type === "Coin flip") result = this.random() < .5;
      else {
        result = this.state.players.find(p => p.id === prompt.playerId)!.deck.cards.map((_, i) => i);
        for (let j = result.length - 1; j > 0; j--) { const k = Math.floor(this.random() * (j + 1)); [result[j], result[k]] = [result[k], result[j]]; }
      }
      this.store.dispatch(new E.ResolvePromptAction(prompt.id, result));
    }
    throw new Error("Random resolution limit exceeded");
  }
  apply(move: Move) {
    if (![1,2].includes(move.seat) || this.state.phase === E.GamePhase.FINISHED) throw new Error("Game is finished or seat is invalid");
    let action: E.Action;
    if (move.type === "answer") {
      const prompt = this.state.prompts.find(p => p.id === move.prompt && p.result === undefined && p.playerId === move.seat);
      if (!prompt || ["Shuffle deck", "Coin flip"].includes(prompt.type)) throw new Error("Not your choice");
      action = new E.ResolvePromptAction(prompt.id, decodeAnswer(prompt, move.result, this.state));
    } else {
      if (this.state.phase !== E.GamePhase.PLAYER_TURN || this.state.players[this.state.activePlayer].id !== move.seat) throw new Error("Not your turn");
      if (move.target && (!integer(move.target.index, 5) || ![1,2].includes(move.target.player) || ![0,1,2,3,4].includes(move.target.slot))) throw new Error("Invalid target");
      switch(move.type) {
        case "play": if (!integer(move.index, this.state.players[move.seat - 1].hand.cards.length) || !move.target || move.target.player !== E.PlayerType.BOTTOM_PLAYER) throw new Error("Invalid card destination"); action = new E.PlayCardAction(move.seat, move.index!, move.target); break;
        case "attack": action = new E.AttackAction(move.seat, move.name!); break;
        case "power": if (!move.target || move.target.player !== E.PlayerType.BOTTOM_PLAYER) throw new Error("Choose your Pokémon"); action = new E.UseAbilityAction(move.seat, move.name!, move.target); break;
        case "trainer": if (!move.target) throw new Error("Choose a card"); action = new E.UseTrainerInPlayAction(move.seat, move.target, move.name!); break;
        case "retreat": if (!integer(move.index, 5)) throw new Error("Invalid bench slot"); action = new E.RetreatAction(move.seat, move.index!); break;
        case "pass": action = new E.PassTurnAction(move.seat); break;
        default: throw new Error("Unknown move");
      }
    }
    this.store.dispatch(action); this.automatic();
  }
}
