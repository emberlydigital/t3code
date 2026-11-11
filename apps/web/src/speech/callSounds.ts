interface Note {
  readonly frequency: number;
  /** Seconds after the sound starts. */
  readonly at: number;
  readonly duration: number;
}

const C5 = 523.25;
const G5 = 783.99;
const VOLUME = 0.12;
const EDGE_SECONDS = 0.02;

/** Plays short sine notes. Each eases in and out, since a hard edge is audible as a click. */
function play(notes: ReadonlyArray<Note>) {
  try {
    const context = new AudioContext();
    const master = context.createGain();
    master.gain.value = VOLUME;
    master.connect(context.destination);
    let finish = 0;
    for (const note of notes) {
      const start = context.currentTime + note.at;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(1, start + EDGE_SECONDS);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);
      oscillator.connect(envelope).connect(master);
      oscillator.start(start);
      oscillator.stop(start + note.duration + EDGE_SECONDS);
      finish = Math.max(finish, note.at + note.duration + EDGE_SECONDS);
    }
    setTimeout(() => void context.close(), (finish + 0.2) * 1000);
  } catch {
    // No audio output is available; the call works without its chime.
  }
}

/** Two notes rising: the call is connected. */
export function playCallStartSound() {
  play([
    { frequency: C5, at: 0, duration: 0.16 },
    { frequency: G5, at: 0.11, duration: 0.24 },
  ]);
}

/** Two notes falling: the call is over. */
export function playCallEndSound() {
  play([
    { frequency: G5, at: 0, duration: 0.14 },
    { frequency: C5, at: 0.1, duration: 0.26 },
  ]);
}
