import { useEffect, useState } from 'react'
import Hub from './studios/Hub'
import StartupOverlay from './StartupOverlay'
import ScriptStudio from './studios/ScriptStudio'
import BlueprintStudio from './studios/BlueprintStudio'
import ComposeStudio from './studios/ComposeStudio'
import StudioSettingsModal from './StudioSettingsModal'

type Stage = 'hub' | 'script' | 'blueprint' | 'compose'

const STAGE_KEY = 'gamestudio.stage'
const PROJECT_KEY = 'gamestudio.projectId'

function loadPersistedStage(): { stage: Stage; projectId: string | null } {
  try {
    // 2026-08-26 修复：刷新后恢复上次打开的界面（原来强制回 Hub，持久化形同虚设）。
    // 仅当 stage 与 projectId 同时有效才恢复进工作室，否则回 Hub。
    const stage = localStorage.getItem(STAGE_KEY)
    const projectId = localStorage.getItem(PROJECT_KEY)
    if (projectId && (stage === 'script' || stage === 'blueprint' || stage === 'compose')) {
      return { stage, projectId }
    }
    return { stage: 'hub', projectId: null }
  } catch {
    return { stage: 'hub', projectId: null }
  }
}

function persistStage(stage: Stage, projectId: string | null) {
  try {
    localStorage.setItem(STAGE_KEY, stage)
    if (projectId) localStorage.setItem(PROJECT_KEY, projectId)
    else localStorage.removeItem(PROJECT_KEY)
  } catch {}
}

export default function App() {
  const [showStartup, setShowStartup] = useState(true)
  const persisted = loadPersistedStage()
  const [stage, setStageState] = useState<Stage>(persisted.stage)
  const [projectId, setProjectIdState] = useState<string | null>(persisted.projectId)
  const [settingsOpen, setSettingsOpen] = useState(false)

  function setStage(next: Stage) {
    setStageState(next)
    if (next === 'hub') setProjectIdState(null)
  }

  function setProjectId(id: string | null) {
    setProjectIdState(id)
  }

  useEffect(() => {
    persistStage(stage, projectId)
  }, [stage, projectId])

  const content =
    stage === 'hub' || !projectId ? (
      <Hub
        onOpenProject={(id, targetStage) => {
          setProjectId(id)
          setStage(targetStage || 'script')
        }}
      />
    ) : stage === 'script' ? (
      <ScriptStudio projectId={projectId} onBack={() => setStage('hub')} onNext={() => setStage('blueprint')} />
    ) : stage === 'blueprint' ? (
      <BlueprintStudio projectId={projectId} onBack={() => setStage('script')} onNext={() => setStage('compose')} />
    ) : (
      <ComposeStudio projectId={projectId} onBack={() => setStage('blueprint')} onBackToHub={() => setStage('hub')} />
    )

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {showStartup ? <StartupOverlay onFinish={() => setShowStartup(false)} /> : null}
      {content}
      <button className="settings-fab" type="button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
        设置
      </button>
      <StudioSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
