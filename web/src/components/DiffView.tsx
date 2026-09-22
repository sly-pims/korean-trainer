export interface DiffSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

interface Props {
  segments: DiffSegment[];
}

/** Highlights removed text in red (strikethrough) and inserted/corrected text in green. */
export function DiffView({ segments }: Props) {
  return (
    <span className="diff-inline">
      {segments.map((s, i) => {
        if (s.type === 'delete') {
          return (
            <span key={i} className="diff-original diff-seg">
              {s.text}
            </span>
          );
        }
        return (
          <span key={i} className={s.type === 'equal' ? 'diff-seg' : 'diff-corrected diff-seg'}>
            {s.text}
          </span>
        );
      })}
    </span>
  );
}