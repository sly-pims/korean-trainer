export interface DiffSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

interface Props {
  segments: DiffSegment[];
}

/** Green = matches the target; red = differs from the target (missing, extra, or substituted). */
export function DiffView({ segments }: Props) {
  return (
    <span className="diff-inline">
      {segments.map((s, i) => (
        <span key={i} className={`${s.type === 'equal' ? 'diff-match' : 'diff-mismatch'} diff-seg`}>
          {s.text}
        </span>
      ))}
    </span>
  );
}