// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class LightningEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.LIGHTNING];

  public set: string = 'BS';

  public name: string = 'Lightning Energy';

  public fullName: string = 'Lightning Energy BS';

}
