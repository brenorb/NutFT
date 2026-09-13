// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class GrassEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.GRASS];

  public set: string = 'BS';

  public name: string = 'Grass Energy';

  public fullName: string = 'Grass Energy BS';

}
