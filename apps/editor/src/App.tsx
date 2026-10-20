import { useEffect, useState } from 'react'
import Hub from './studios/Hub'
import StartupOverlay from './StartupOverlay'
import ScriptStudio from './studios/ScriptStudio'
import BlueprintStudio from './studios/BlueprintStudio'
import ComposeStudio from './studios/ComposeStudio'
import SettingsPage from './pages/SettingsPage'
import CreateStoryPage from './pages/CreateStoryPage'
import { DialogHost } from './dialog'
import TaskIndicator from './tasks/TaskIndicator'

type Stage = 'hub' | 'script' | 'blueprint' | 'compose' | 'settings' | 'create'
type WorkStage = Exclude<Stage, 'settings' | 'create'>

const STAGE_KEY = 'talkscene.stage'
const PROJECT_KEY = 'talkscene.projectId'

function loadPersistedStage(): { stage: Stage; projectId: string | null } {
  try {
    // 2026-08-26 修复：刷新后恢复上次打开的界面（原来强制回 Hub，持久化形同虚设）。
    // 仅当 stage 与 projectId 同时有效才恢复进工作室，否则回 Hub。
    // 2026-10-20 设置页：settings 为独立页面（路由级 stage），刷新后同样恢复。
    const stage = localStorage.getItem(STAGE_KEY)
    const projectId = localStorage.getItem(PROJECT_KEY)
    // 设置页/新建页为独立页面（路由级 stage），刷新后同样恢复
    if (stage === 'settings' || stage === 'create') {
      return { stage, projectId: projectId || null }
    }
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
  // 进入设置页前的来源界面（页内「返回」回到来源）；刷新后来源丢失则回 Hub
  const [settingsReturn, setSettingsReturn] = useState<{ stage: WorkStage; projectId: string | null } | null>(null)
  // 进入新建页前的来源界面（同上）
  const [createReturn, setCreateReturn] = useState<{ stage: WorkStage; projectId: string | null } | null>(null)

  function setStage(next: Stage) {
    setStageState(next)
    if (next === 'hub') setProjectIdState(null)
  }

  function setProjectId(id: string | null) {
    setProjectIdState(id)
  }

  function openSettings() {
    setSettingsReturn({ stage: stage === 'settings' || stage === 'create' ? 'hub' : stage, projectId })
    setStageState('settings')
  }

  function closeSettings() {
    const ret = settingsReturn
    setSettingsReturn(null)
    if (ret && ret.stage !== 'hub' && ret.projectId) {
      setProjectIdState(ret.projectId)
      setStageState(ret.stage)
    } else {
      setStage('hub')
    }
  }

  function openCreate() {
    setCreateReturn({ stage: stage === 'settings' || stage === 'create' ? 'hub' : stage, projectId })
    setStageState('create')
  }

  function closeCreate() {
    const ret = createReturn
    setCreateReturn(null)
    if (ret && ret.stage !== 'hub' && ret.projectId) {
      setProjectIdState(ret.projectId)
      setStageState(ret.stage)
    } else {
      setStage('hub')
    }
  }

  useEffect(() => {
    persistStage(stage, projectId)
  }, [stage, projectId])

  const content =
    stage === 'settings' ? (
      <SettingsPage onBack={closeSettings} />
    ) : stage === 'create' ? (
      <CreateStoryPage
        onBack={closeCreate}
        onCreated={(id) => {
          setCreateReturn(null)
          setProjectIdState(id)
          setStageState('script')
        }}
        onOpenSettings={openSettings}
      />
    ) : stage === 'hub' || !projectId ? (
      <Hub
        onOpenProject={(id, targetStage) => {
          setProjectId(id)
          setStage(targetStage || 'script')
        }}
        onOpenSettings={openSettings}
        onCreateStory={openCreate}
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
      {/* 设置入口：首页顶栏已自带；浮钮只在工作室页显示，避免双入口 */}
      {stage !== 'settings' && stage !== 'hub' && stage !== 'create' ? (
        <button className="settings-fab" type="button" onClick={openSettings} aria-label="打开设置">
          设置
        </button>
      ) : null}
      {/* 设置页为唯一设置入口（独立页面）；旧弹窗 StudioSettingsModal 已于 2026-10-20 退役删除 */}
      {/* 全局任务指示器：任何长任务界面可见（进度/失败原因），不依赖守护台 */}
      <TaskIndicator
        onOpenProject={(id) => {
          setProjectId(id)
          setStage('compose')
        }}
      />
      <DialogHost />
    </div>
  )
}
