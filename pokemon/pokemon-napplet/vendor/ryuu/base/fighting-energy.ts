// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class FightingEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.FIGHTING];

  public set: string = 'BS';

  public name: string = 'Fighting Energy';

  public fullName: string = 'Fighting Energy BS';

}
