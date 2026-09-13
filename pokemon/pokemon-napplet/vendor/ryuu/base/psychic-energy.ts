// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import {
  CardType,
  EnergyCard,
} from '../common/index';

export class PsychicEnergy extends EnergyCard {
  public provides: CardType[] = [CardType.PSYCHIC];

  public set: string = 'BS';

  public name: string = 'Psychic Energy';

  public fullName: string = 'Psychic Energy BS';

}
