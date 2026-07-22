import { createRouter, createWebHashHistory } from 'vue-router'
import ConsoleLayout from '../layouts/ConsoleLayout.vue'

const routes = [
  {
    path: '/',
    component: ConsoleLayout,
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../pages/DashboardPage.vue'),
        meta: { title: '总览', icon: '□' }
      },
      {
        path: 'generators',
        name: 'Generators',
        component: () => import('../pages/GeneratorsPage.vue'),
        meta: { title: '生成工具', icon: '⚙' }
      },
      {
        path: 'agents',
        name: 'Agents',
        component: () => import('../pages/AgentsPage.vue'),
        meta: { title: '本地 Agent', icon: '◆' }
      },
      {
        path: 'projects',
        name: 'Projects',
        component: () => import('../pages/ProjectsPage.vue'),
        meta: { title: '项目', icon: '▣' }
      },
      {
        path: 'sessions',
        name: 'Sessions',
        component: () => import('../pages/SessionsPage.vue'),
        meta: { title: '任务与会话', icon: '▶' }
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('../pages/LogsPage.vue'),
        meta: { title: '日志与诊断', icon: '≡' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { title: '设置', icon: '⚙' }
      },
      {
        path: 'workbench',
        name: 'Workbench',
        component: () => import('../pages/WorkbenchPage.vue'),
        meta: { title: '工作台', icon: '⌘' }
      }
    ]
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
