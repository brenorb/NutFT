// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class FireEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.FIRE];

  public set: string = 'BS';

  public name: string = 'Fire Energy';

  public fullName: string = 'Fire Energy BS';

}
