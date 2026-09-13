// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class WaterEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.WATER];

  public set: string = 'BS';

  public name: string = 'Water Energy';

  public fullName: string = 'Water Energy BS';

}
