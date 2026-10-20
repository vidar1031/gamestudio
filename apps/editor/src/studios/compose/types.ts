import {
  type ProjectV1,
  type StoryV1
} from '../../api'

export type Selection =
  | { type: 'none' }
  | { type: 'node'; id: string }
  | { type: 'character'; id: string }
  | { type: 'asset'; id: string }

export type LeftTab = 'nodes' | 'characters' | 'assets' | 'materials'

export type LatestExportAction = 'overwrite' | 'delete' | 'cancel'

	export type EditorDoc = {
	  mode: 'project' | 'none'
	  readonly: boolean
	  id: string
	  title: string
	  assetBase: string
	  project: ProjectV1 | null
  story: StoryV1 | null
}
