// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.
import { State } from './state/state';

export interface StoreHandler {

  onStateChange(state: State): void;

}
