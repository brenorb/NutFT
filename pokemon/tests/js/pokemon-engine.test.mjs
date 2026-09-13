import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,E,definitions,catalog,validateDeck,choices,decodeAnswer,own} from '../../site/pokemon/engine.mjs';
const deck=[...Array(4).fill('base1-58'),...Array(56).fill('base1-100')];
const card=id=>E.CardManager.getInstance().getCardByName(definitions.get(id).fullName);
function started() {
  const game=new Game([deck,deck],'test');
  while(game.state.phase===E.GamePhase.SETUP){
    const p=game.state.prompts.find(p=>p.result===undefined);
    const options=choices(p,game.state);
    game.apply({seat:p.playerId,type:'answer',prompt:p.id,result:p.type==='Choose cards'?[options[0].value]:p.type==='Select'?0:true});
  }
  return game;
}
function field(g,seat,active='base1-58',bench='base1-58') {
  const p=g.state.players[seat-1];
  p.active=new E.PokemonSlot();p.active.pokemons.cards=[card(active)];
  p.bench[0]=new E.PokemonSlot();p.bench[0].pokemons.cards=[card(bench)];
  return p;
}
test('all 102 Base Set assets map to programmed definitions; no partial deck bypass',()=>{
  assert.equal(catalog.length,102);assert.equal(definitions.size,102);
  for(const definition of definitions.values())assert.equal(typeof definition.reduceEffect,'function');
  validateDeck(deck);
  assert.throws(()=>validateDeck(deck.slice(1)),/60/);
  assert.throws(()=>validateDeck([...Array(5).fill('base1-58'),...Array(55).fill('base1-100')]),/four/);
  assert.throws(()=>validateDeck(Array(60).fill('base1-100')),/Basic/);
});
test('Base Set mulligan lets the opponent choose zero, one or two bonus cards',()=>{
  let g,p;
  for(let seed=0;seed<100;seed++){g=new Game([deck,deck],'mulligan-'+seed);p=g.state.prompts.find(p=>p.result===undefined&&p.type==='Show cards');if(p)break;}
  assert.ok(p);const seat=p.playerId,before=g.state.players[seat-1].hand.cards.length;
  while(g.state.prompts.some(p=>p.result===undefined&&['Show cards','Alert'].includes(p.type))){const prompt=g.state.prompts.find(p=>p.result===undefined&&['Show cards','Alert'].includes(p.type));g.apply({seat:prompt.playerId,type:'answer',prompt:prompt.id,result:true});}
  const select=g.state.prompts.find(p=>p.result===undefined&&p.type==='Select'&&p.playerId===seat);
  assert.ok(select,'Mulligan bonus must offer 0–2 cards');assert.deepEqual(choices(select,g.state).map(o=>o.value),[0,1,2]);
  g.apply({seat,type:'answer',prompt:select.id,result:2});assert.equal(g.state.players[seat-1].hand.cards.length,before+2);
});
test('setup rejects duplicated cards and another player answering the prompt',()=>{
  const g=new Game([deck,deck],'test');const p=g.state.prompts.find(p=>p.result===undefined);
  const index=choices(p,g.state)[0].value;
  assert.throws(()=>g.apply({type:'answer',seat:p.playerId,prompt:p.id,result:[index,index]}),/distinct/);
  assert.throws(()=>g.apply({type:'answer',seat:3-p.playerId,prompt:p.id,result:[index]}),/Not your choice/);
});
test('replay is deterministic and random outcomes cannot be supplied by a player',()=>{
  const a=started(),b=started();assert.equal(JSON.stringify(a.state),JSON.stringify(b.state));
  assert.equal(a.state.turn,1);
  assert.throws(()=>a.apply({seat:3-a.state.players[a.state.activePlayer].id,type:'pass'}),/Not your turn/);
});
test('one Energy per turn, legal attack ends the turn, first-player attack allowed',()=>{
  const g=started();const seat=g.state.players[g.state.activePlayer].id;
  const p=field(g,seat);field(g,3-seat);p.hand.cards=[card('base1-100'),card('base1-100')];
  g.apply({type:'play',seat,index:0,target:own()});
  assert.throws(()=>g.apply({type:'play',seat,index:0,target:own()}));
  g.apply({type:'attack',seat,name:'Gnaw'});
  assert.equal(g.state.players[2-seat].active.damage,10);assert.equal(g.state.turn,2);
});
test('Bill automatically draws two and discards itself',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id,p=g.state.players[seat-1];
  p.hand.cards=[card('base1-91')];const before=p.deck.cards.length;
  g.apply({type:'play',seat,index:0,target:{player:2,slot:0,index:0}});
  assert.equal(p.hand.cards.length,2);assert.equal(p.deck.cards.length,before-2);assert.equal(p.discard.cards.at(-1).name,'Bill');
});
test('weakness and knockout trigger a prize choice automatically',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id;
  const p=field(g,seat,'base1-52');const opponent=field(g,3-seat);
  p.active.energies.cards=[card('base1-97')];
  g.apply({type:'attack',seat,name:'Low Kick'});
  assert.equal(opponent.discard.cards[0].name,'Pikachu');
  assert.ok(g.state.prompts.some(p=>p.result===undefined&&p.type==='Choose prize'));
});
test('Base Set confusion deals 20 self-damage with weakness and resistance',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id,p=field(g,seat,'base1-45');field(g,3-seat);
  p.active.specialConditions=[E.SpecialCondition.CONFUSED];p.active.energies.cards=[card('base1-99')];g.random=()=>0.9;
  g.apply({type:'attack',seat,name:'String Shot'});
  assert.equal(p.active.damage,20);
});
test('Base Set permits multiple retreats and confusion pays before failed retreat',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id,p=field(g,seat,'base1-48','base1-48');field(g,3-seat);
  g.apply({type:'retreat',seat,index:0});g.apply({type:'retreat',seat,index:0});
  p.active.pokemons.cards=[card('base1-58')];p.active.energies.cards=[card('base1-100')];p.active.specialConditions=[E.SpecialCondition.CONFUSED];g.random=()=>0.9;
  g.apply({type:'retreat',seat,index:0});const prompt=g.state.prompts.find(p=>p.result===undefined);
  g.apply({type:'answer',seat,prompt:prompt.id,result:[0]});
  assert.equal(p.active.getPokemonCard().name,'Pikachu');assert.equal(p.active.energies.cards.length,0);
});
test('Damage Swap cannot knock out its recipient or move unavailable counters',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id,p=field(g,seat,'base1-1');
  p.active.damage=20;p.bench[0].damage=30;
  g.apply({type:'power',seat,name:'Damage Swap',target:own()});const prompt=g.state.prompts.find(p=>p.result===undefined);
  assert.throws(()=>decodeAnswer(prompt,[{from:own(),to:own(0)}],g.state),/Damage/);
  p.bench[0].damage=0;
  assert.throws(()=>decodeAnswer(prompt,Array(3).fill({from:own(),to:own(0)}),g.state),/Damage/);
});
test('poison damage is applied between turns and deck-out ends a game',()=>{
  const g=started(),seat=g.state.players[g.state.activePlayer].id,p=field(g,seat,'base1-2');field(g,3-seat,'base1-2');
  p.active.specialConditions=[E.SpecialCondition.POISONED];p.active.poisonDamage=30;
  g.apply({type:'pass',seat});assert.equal(p.active.damage,30);
  g.state.players[seat-1].deck.cards=[];
  g.apply({type:'pass',seat:3-seat});assert.equal(g.state.phase,E.GamePhase.FINISHED);
});
