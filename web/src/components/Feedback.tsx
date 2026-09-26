import type { WritingFeedback, SpeakingFeedback } from '../types';
import { SpeakButton } from './SpeakButton';

/** Render an issue list for writing or speaking feedback. */
function Issues({ feedback }: { feedback: { issues: { original: string; fix: string; type: string; explanation_native: string }[] } }) {
  if (!feedback.issues.length) return null;
  return (
    <div className="card">
      <h3>Issues ({feedback.issues.length})</h3>
      {feedback.issues.map((it, i) => (
        <div key={i} className="list-item">
          <div className="grow">
            <div className="row wrap">
              <span className="tag small-label">{it.type}</span>
              <span className="small muted">"{it.original}" → "{it.fix}"</span>
            </div>
            <p className="small muted">{it.explanation_native}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function PronunciationNotes({ notes }: { notes: { word: string; note_native: string; confidence: string }[] }) {
  if (!notes.length) return null;
  return (
    <div className="card">
      <h3>Pronunciation notes</h3>
      {notes.map((n, i) => (
        <div key={i} className="list-item">
          <span className="target-text">{n.word}</span>
          <span className="small muted grow">{n.note_native}</span>
          <span className={`tag ${n.confidence === 'high' ? '' : 'small-label'}`}>{n.confidence}</span>
        </div>
      ))}
    </div>
  );
}

/** Writing evaluation block (§8.2). */
export function WritingEvaluation({ feedback, rate, voiceUri }: { feedback: WritingFeedback; rate: number; voiceUri?: string | null }) {
  return (
    <>
      <div className="card">
        <div className="row">
          <div className="center grow">
            <span className="score-ring">{feedback.score}/5</span>
            <p className="small muted">grade</p>
          </div>
          <p className="small muted">{feedback.encouragement_native}</p>
        </div>
      </div>
      <div className="card">
        <h3>Corrected version</h3>
        <div className="row">
          {feedback.more_natural_target && (
            <>
              <p className="target-text grow" style={{ color: 'var(--good)' }}>
                ✍ {feedback.more_natural_target}
              </p>
              <SpeakButton text={feedback.more_natural_target} rate={rate} voiceUri={voiceUri} label="Play corrected" />
            </>
          )}
        </div>
        <p className="target-text muted">{feedback.corrected_target}</p>
      </div>
      <Issues feedback={feedback} />
    </>
  );
}

/** Speaking evaluation block (§8.3). */
export function SpeakingEvaluation({ feedback, rate, voiceUri }: { feedback: SpeakingFeedback; rate: number; voiceUri?: string | null }) {
  return (
    <>
      <div className="card">
        <div className="row">
          <div className="center grow">
            <span className="score-ring">{feedback.score}/5</span>
            <p className="small muted">grade</p>
          </div>
          <p className="small muted">{feedback.encouragement_native}</p>
        </div>
        {feedback.fluency_note_native && <p className="small muted">🗣 {feedback.fluency_note_native}</p>}
      </div>
      <div className="card">
        <h3>What you said</h3>
        <p className="target-text">{feedback.transcript_target}</p>
      </div>
      {feedback.more_natural_target && (
        <div className="card">
          <h3>More natural</h3>
          <div className="row">
            <p className="target-text grow" style={{ color: 'var(--good)' }}>
              ✍ {feedback.more_natural_target}
            </p>
            <SpeakButton text={feedback.more_natural_target} rate={rate} voiceUri={voiceUri} label="Play corrected" />
          </div>
        </div>
      )}
      {feedback.corrected_target && (
        <div className="card">
          <h3>Corrected</h3>
          <div className="row">
            <p className="target-text grow muted">{feedback.corrected_target}</p>
            <SpeakButton text={feedback.corrected_target} rate={rate} voiceUri={voiceUri} label="Play corrected" />
          </div>
        </div>
      )}
      <Issues feedback={feedback} />
      <PronunciationNotes notes={feedback.pronunciation_notes} />
    </>
  );
}