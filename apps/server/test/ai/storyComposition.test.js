import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateCompositionCoverage } from '../../src/ai/storyComposition.js'

const expectedScene = {
  sceneId: 'snow-white-at-cottage',
  subjects: [
    { subjectId: 'snow-white' },
    ...['doc', 'grumpy', 'happy', 'sleepy', 'bashful', 'sneezy', 'dopey'].map((id) => ({ subjectId: `dwarf-${id}` })),
    { subjectId: 'glass-coffin' }
  ]
}

function compositionFor(subjectIds) {
  return {
    scenes: [{
      sceneId: expectedScene.sceneId,
      items: subjectIds.map((subjectId) => ({ subjectId }))
    }]
  }
}

describe('Story composition coverage', () => {
  it('accepts a complete multi-character scene with a key prop', () => {
    const ids = expectedScene.subjects.map((subject) => subject.subjectId)
    assert.deepEqual(validateCompositionCoverage(compositionFor(ids), [expectedScene]), [])
  })

  it('rejects omitted characters and props instead of treating partial blocking as complete', () => {
    const ids = expectedScene.subjects
      .filter((subject) => subject.subjectId !== 'dwarf-dopey' && subject.subjectId !== 'glass-coffin')
      .map((subject) => subject.subjectId)
    assert.deepEqual(
      validateCompositionCoverage(compositionFor(ids), [expectedScene]),
      [
        'missing_subject:snow-white-at-cottage:dwarf-dopey',
        'missing_subject:snow-white-at-cottage:glass-coffin'
      ]
    )
  })

  it('rejects an omitted expected scene', () => {
    assert.deepEqual(
      validateCompositionCoverage({ scenes: [] }, [expectedScene]),
      ['composition_empty']
    )
  })

  it('rejects duplicate scene results instead of silently checking only the last one', () => {
    const complete = compositionFor(expectedScene.subjects.map((subject) => subject.subjectId)).scenes[0]
    const partial = compositionFor(['snow-white']).scenes[0]
    assert.deepEqual(
      validateCompositionCoverage({ scenes: [complete, partial] }, [expectedScene]),
      ['duplicate_scene:snow-white-at-cottage']
    )
  })
})