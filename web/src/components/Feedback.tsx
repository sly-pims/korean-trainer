import type { WritingFeedback, SpeakingFeedback } from '../types';
import { SpeakButton } from './SpeakButton';

/** Render an issue list for writing or speaking feedback. */
function Issues({ feedback }: { feedback: { issues: { original: string; fix: string; type: string; explanation_en: string }[] } }) {
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
            <p className="small muted">{it.explanation_en}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function PronunciationNotes({ notes }: { notes: { word: string; note_en: string; confidence: string }[] }) {
  if (!notes.length) return null;
  return (
    <div className="card">
      <h3>Pronunciation notes</h3>
      {notes.map((n, i) => (
        <div key={i} className="list-item">
          <span className="ko">{n.word}</span>
          <span className="small muted grow">{n.note_en}</span>
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
          <p className="small muted">{feedback.encouragement_en}</p>
        </div>
      </div>
      <div className="card">
        <h3>Corrected version</h3>
        <div className="row">
          {feedback.more_natural_ko && (
            <>
              <p className="ko grow" style={{ color: 'var(--good)' }}>
                ✍ {feedback.more_natural_ko}
              </p>
              <SpeakButton text={feedback.more_natural_ko} rate={rate} voiceUri={voiceUri} label="Play corrected" />
            </>
          )}
        </div>
        <p className="ko muted">{feedback.corrected_ko}</p>
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
          <p className="small muted">{feedback.encouragement_en}</p>
        </div>
        {feedback.fluency_note_en && <p className="small muted">🗣 {feedback.fluency_note_en}</p>}
      </div>
      <div className="card">
        <h3>What you said</h3>
        <p className="ko">{feedback.transcript_ko}</p>
      </div>
      {feedback.more_natural_ko && (
        <div className="card">
          <h3>More natural</h3>
          <div className="row">
            <p className="ko grow" style={{ color: 'var(--good)' }}>
              ✍ {feedback.more_natural_ko}
            </p>
            <SpeakButton text={feedback.more_natural_ko} rate={rate} voiceUri={voiceUri} label="Play corrected" />
          </div>
        </div>
      )}
      {feedback.corrected_ko && (
        <div className="card">
          <h3>Corrected</h3>
          <div className="row">
            <p className="ko grow muted">{feedback.corrected_ko}</p>
            <SpeakButton text={feedback.corrected_ko} rate={rate} voiceUri={voiceUri} label="Play corrected" />
          </div>
        </div>
      )}
      <Issues feedback={feedback} />
      <PronunciationNotes notes={feedback.pronunciation_notes} />
    </>
  );
}