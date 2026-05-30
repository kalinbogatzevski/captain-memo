// src/services/embedder-installer/types.ts — OS-agnostic local-sidecar installer.
//
// Only invoked when the user picks the `local-sidecar` embedder. The hosted-Voyage
// and openai-compatible backends are pure HTTP and need no installer at all. One
// interface, two impls (bash wraps install-embedder.sh, powershell wraps
// install-embedder.ps1), one factory (./index.ts).

export interface EmbedderInstallOpts {
  /** Where the Python venv + model live, e.g. ~/.captain-memo/embed. */
  installDir: string;
  /** Embedder model id, e.g. 'voyageai/voyage-4-nano'. */
  model: string;
  /** Localhost port the sidecar serves /v1/embeddings on (default 8124). */
  port: number;
}

export interface EmbedderInstaller {
  install(opts: EmbedderInstallOpts): Promise<void>;
  remove(installDir: string): Promise<void>;
}
