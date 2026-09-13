// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import { GameMessage } from './game-message';

export class GameError {
  public message: string;

  constructor(code: GameMessage, message?: string) {
    this.message = message || code;
  }

}
