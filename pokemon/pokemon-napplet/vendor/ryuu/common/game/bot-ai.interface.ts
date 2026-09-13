// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import { Action, State } from '../store';

export interface BotAi {
  decodeNextAction(state: State): Action | undefined;
}

export abstract class BotAiFactory {
  constructor(public name: string) { }

  public abstract createBotAi(playerId: number, deck: string[] | null): BotAi;
}
