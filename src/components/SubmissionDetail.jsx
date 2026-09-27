import React from 'react'
import styles from './SubmissionDetail.module.css'

export function calcScore(questions, answers) {
  const mc = questions.filter(q => q.type === 'multiple_choice')
  if (mc.length === 0) return null
  const correct = mc.filter(q => answers[q.id] === q.correct).length
  return { correct, total: mc.length }
}

const EVENT_ICON = {
  violation: '⚠️ ', note: '📋 ', submitted: '✅ ', joined: '→ ', disconnected: '← ',
  keystrokes: '⌨️ ', brief_exit: '↩ ', env: '🖥 ', duplicate_submission: '⚠️ ',
}

// One student's full submission: every answer graded where possible, then
// that student's activity log for the sitting.
export default function SubmissionDetail({ sub, exam, events }) {
  const studentEvents = (events || []).filter(e => e.student_name === sub.student_name)
  return (
    <div className={styles.wrap}>
      <h3 className={styles.section}>Answers</h3>
      <div className={styles.answers}>
        {exam.questions.map((q, qi) => {
          const ans = sub.answers?.[q.id]
          const isCorrect = q.type === 'multiple_choice' ? ans === q.correct : null
          return (
            <div
              key={q.id}
              className={`${styles.answerRow} ${isCorrect === true ? styles.answerCorrect : isCorrect === false ? styles.answerWrong : ''}`}
            >
              <div className={styles.answerMeta}>
                <span className={styles.answerQNum}>Q{qi + 1}</span>
                <span className={styles.answerType}>{q.type.replace('_', ' ')}</span>
                {isCorrect === true && <span className={styles.answerMark}>✓ Correct</span>}
                {isCorrect === false && <span className={styles.answerMarkWrong}>✗ Wrong</span>}
              </div>
              <p className={styles.answerQ}>{q.text}</p>
              {q.type === 'drawing' ? (
                ans
                  ? <img src={ans} alt="Student drawing" className={styles.drawing} />
                  : <p className={styles.noAnswer}>(no drawing)</p>
              ) : q.type === 'multiple_choice' ? (
                <div className={styles.mcOptions}>
                  {q.options.map((opt, i) => (
                    <div key={i} className={`${styles.mcOpt} ${i === q.correct ? styles.mcCorrect : ''} ${ans === i && i !== q.correct ? styles.mcChosen : ''}`}>
                      {i === q.correct && '✓ '}
                      {ans === i && i !== q.correct && '✗ '}
                      {opt}
                      {i === q.correct && ans !== i && <span className={styles.mcHint}> (correct answer)</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.answerA}>{ans || <em className={styles.noAnswer}>(no answer)</em>}</p>
              )}
            </div>
          )
        })}
      </div>

      {studentEvents.length > 0 && (
        <>
          <h3 className={styles.section} style={{ marginTop: '1.25rem' }}>Activity Log</h3>
          <div className={styles.eventList}>
            {studentEvents.map((e, i) => (
              <div key={i} className={`${styles.eventRow} ${styles[`event_${e.type}`] || ''}`}>
                <span className={styles.eventTime}>{new Date(e.at).toLocaleTimeString()}</span>
                <span className={styles.eventMsg}>{EVENT_ICON[e.type] || ''}{e.detail || e.type}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
