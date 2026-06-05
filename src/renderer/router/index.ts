/**
 * 功能描述：Vue Router 配置
 *
 * 逻辑说明：定义六个路由页面：首页、创建房间、加入房间、房间内、设置、日志。
 *           使用路由懒加载（动态 import）。
 */

import { createRouter, createMemoryHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: '首页' }
  },
  {
    path: '/host',
    name: 'host',
    component: () => import('../views/HostView.vue'),
    meta: { title: '创建房间' }
  },
  {
    path: '/join',
    name: 'join',
    component: () => import('../views/JoinView.vue'),
    meta: { title: '加入房间' }
  },
  {
    path: '/room/:roomCode',
    name: 'room',
    component: () => import('../views/RoomView.vue'),
    meta: { title: '房间' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '设置' }
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('../views/LogView.vue'),
    meta: { title: '日志' }
  }
]

export const router = createRouter({
  history: createMemoryHistory(),
  routes
})
