// @ts-nocheck — vendored MIT upstream; behavioral tests exercise this engine.

export interface JsonPathDiff {
  op: 'add' | 'set' | 'del' | 'move';
  path: string[];
  val: any;
}

export interface JsonDiff {
  op: 'add' | 'set' | 'del' | 'move';
  path: string;
  val: any;
}
