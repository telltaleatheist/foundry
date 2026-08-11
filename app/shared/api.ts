/**
 * The contextBridge surface, declared where BOTH sides can see it.
 *
 * The renderer cannot import the preload (it imports `electron`), and the
 * preload must not invent a shape the renderer then re-declares by hand — two
 * hand-written copies of one interface is one refactor away from a silent
 * mismatch. So the interface lives here: preload.ts implements it, and the
 * renderer's `window.foundry` is typed as it.
 */
import type {
  BackendSettingsPatch,
  DoctorResult,
  EngineInfo,
  EnvTooling,
  Job,
  JobRequest,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupRequest,
  SetupResult,
  WslFacts,
} from './types';

export interface FoundryApi {
  /** process.platform, for the one or two places the UI says "on Windows". */
  platform: string;

  /** The menu's File→Open, callable from the UI too. Resolves to the path, or null. */
  openPdfDialog(): Promise<string | null>;
  /**
   * A dropped file's path, admitted by main or refused. The renderer cannot read
   * the file either way — this only tells the viewer what it may ask for.
   */
  openPath(candidate: string): Promise<string | null>;
  /**
   * The real path behind a dropped `File`. Electron removed `File.path` in
   * favour of `webUtils.getPathForFile`, and it is the reason a drop needs a
   * preload at all.
   */
  pathForFile(file: File): string;
  /** The `foundry-file://` URL an <iframe> can point at. */
  documentUrl(absolutePath: string): string;
  chooseOutputPath(defaultPath: string): Promise<string | null>;
  reveal(target: string): Promise<void>;

  queue: {
    list(): Promise<Job[]>;
    enqueue(request: JobRequest): Promise<Job>;
    cancel(id: string): Promise<void>;
    clearFinished(): Promise<void>;
    /** Every change, whole list. Returns its own unsubscribe. */
    onChanged(listener: (jobs: Job[]) => void): () => void;
  };

  engineInfo(): Promise<EngineInfo>;
  doctor(endpointUrl?: string): Promise<DoctorResult>;
  settings: {
    read(): Promise<SettingsView>;
    write(patch: BackendSettingsPatch): Promise<SettingsView>;
  };

  /**
   * WSL, and the environment vLLM is served from.
   *
   * Facts are re-measured on demand rather than cached in the renderer: a user
   * who installs a distro while the settings screen is open should be able to
   * press the button again and see it.
   */
  wsl: {
    /** Which distros exist, or why there are none. */
    facts(): Promise<WslFacts>;
    /** What one distro can build an environment with. */
    tooling(distro: string): Promise<EnvTooling>;
  };

  backendSetup: {
    /**
     * Build the environment. Resolves with the outcome; a failure is a result,
     * not a rejection, because every one of them is a sentence to read.
     */
    run(request: SetupRequest): Promise<SetupResult>;
    cancel(): Promise<void>;
    /** Every line, as it happens. Returns its own unsubscribe. */
    onLog(listener: (event: SetupLogEvent) => void): () => void;
  };

  vllmServer: {
    status(): Promise<ServerStatus>;
    /** Rejects with the guest's log tail when it will not start. */
    start(): Promise<ServerStatus>;
    stop(): Promise<ServerStatus>;
    onStatus(listener: (status: ServerStatus) => void): () => void;
  };

  onDocumentOpened(listener: (absolutePath: string) => void): () => void;
  onNavigate(listener: (route: string) => void): () => void;
}
