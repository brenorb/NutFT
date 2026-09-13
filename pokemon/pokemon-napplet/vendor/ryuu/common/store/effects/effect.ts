// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.

export interface Effect {
  readonly type: string;
  preventDefault: boolean;
}
