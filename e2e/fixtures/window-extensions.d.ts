/**
 * Window extensions for e2e testing.
 * These are properties added to window during test execution.
 */

interface MeshInstance {
  beginTx(track: MediaStreamTrack): Promise<unknown>;
  endTx(): void;
  retryPendingDials(): void;
  peer: { id?: string } | null;
}

interface Window {
  __testTxTrack?: MediaStreamTrack;
  __testChunks?: Blob[];
  mesh?: MeshInstance;
}