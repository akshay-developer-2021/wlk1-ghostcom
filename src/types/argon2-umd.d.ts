/* Types for the argon2-only UMD build (deep import keeps the other 20
   hash-wasm algorithms out of the bundle — the flat ESM entry defeats
   treeshaking). Runtime verified: default export carries argon2id. */
declare module 'hash-wasm/dist/argon2.umd.min.js' {
  export interface Argon2UmdOptions {
    password: string | Uint8Array;
    salt: string | Uint8Array;
    secret?: string | Uint8Array;
    iterations: number;
    parallelism: number;
    memorySize: number;
    hashLength: number;
    outputType?: 'hex' | 'binary' | 'encoded';
  }
  export interface Argon2Umd {
    argon2id(opts: Argon2UmdOptions & { outputType: 'binary' }): Promise<Uint8Array>;
    argon2id(opts: Argon2UmdOptions): Promise<string>;
  }
  const def: Argon2Umd;
  export default def;
}
