// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import { Prompt } from './prompt';
import { GameMessage } from '../../game-message';

export class AlertPrompt extends Prompt<true> {

  readonly type: string = 'Alert';

  constructor(playerId: number, public message: GameMessage) {
    super(playerId);
  }

}
