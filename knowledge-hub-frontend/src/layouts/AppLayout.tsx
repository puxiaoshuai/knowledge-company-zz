import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BellOutlined,
  ClusterOutlined,
  FileTextOutlined,
  HomeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Dropdown, Layout, Menu, Tag } from 'antd'
import type { MenuProps } from 'antd'
import { authApi, teamApi } from '../api'
import { clearAuth, updateUser, useAuth } from '../auth'
import { can, displayName, isAdmin, isReviewer } from '../utils'
import { BrandLogo } from '../components/BrandLogo'
import type { TeamItem } from '../types'

const { Header, Sider, Content } = Layout

type MenuItem = NonNullable<MenuProps['items']>[number]

/** 路径所属的分组子菜单（文档管理 / 系统管理） */
function groupOf(pathname: string): string[] {
  if (pathname.startsWith('/documents') || pathname.startsWith('/admin/reviews')) {
    return ['nav-documents']
  }
  if (pathname.startsWith('/admin')) return ['nav-admin']
  return []
}

export default function AppLayout() {
  const user = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [openKeys, setOpenKeys] = useState<string[]>(groupOf(location.pathname))
  const [myTeams, setMyTeams] = useState<TeamItem[]>([])

  useEffect(() => {
    authApi.me().then(updateUser).catch(() => undefined)
    teamApi.mine().then(setMyTeams).catch(() => undefined)
  }, [])

  // 页面内跳转（如铃铛进审核工作台）时，确保目标分组子菜单展开
  useEffect(() => {
    const group = groupOf(location.pathname)
    if (group.length) {
      setOpenKeys((prev) => {
        const merged = [...new Set([...prev, ...group])]
        return merged.length === prev.length ? prev : merged
      })
    }
  }, [location.pathname])

  const sectionTitle = useMemo(() => {
    const p = location.pathname
    if (p.startsWith('/admin/reviews')) return '审核工作台'
    if (p.startsWith('/admin')) return '系统管理'
    if (p.startsWith('/documents')) return '文档管理'
    if (p.startsWith('/search')) return '文档搜索'
    if (p.startsWith('/chat')) return 'AI智能问答'
    if (p.startsWith('/graph')) return '知识图谱'
    if (p.startsWith('/profile')) return '个人中心'
    return '首页大盘'
  }, [location.pathname])

  const selectedKeys = useMemo(() => {
    const p = location.pathname
    // 文档详情/编辑页高亮「可见文档」
    if (/^\/documents\/\d+/.test(p)) return ['/documents']
    return [p]
  }, [location.pathname])

  const menuItems = useMemo(() => {
    const items: MenuItem[] = [{ key: '/dashboard', icon: <HomeOutlined />, label: '首页大盘' }]
    if (can(user, 'document:list')) {
      const docs: MenuItem[] = [
        { key: '/documents', icon: <ReadOutlined />, label: '可见文档' },
        { key: '/documents/new', icon: <FileTextOutlined />, label: '新建文档' },
      ]
      if (isReviewer(user)) {
        docs.push({ key: '/admin/reviews', icon: <BellOutlined />, label: '审核工作台' })
      }
      items.push({ key: 'nav-documents', icon: <FileTextOutlined />, label: '文档管理', children: docs })
    }
    if (can(user, 'search')) {
      items.push({ key: '/search', icon: <SearchOutlined />, label: '文档搜索' })
      items.push({ key: '/chat', icon: <MessageOutlined />, label: 'AI智能问答' })
      items.push({ key: '/graph', icon: <ClusterOutlined />, label: '知识图谱' })
    }
    if (can(user, 'profile')) {
      items.push({ key: '/profile', icon: <UserOutlined />, label: '个人中心' })
    }
    if (isAdmin(user)) {
      items.push({
        key: 'nav-admin',
        icon: <SettingOutlined />,
        label: '系统管理',
        children: [
          { key: '/admin/users', icon: <UserOutlined />, label: '用户管理' },
          { key: '/admin/roles', icon: <SafetyCertificateOutlined />, label: '角色权限' },
          { key: '/admin/teams', icon: <TeamOutlined />, label: '团队管理' },
        ],
      })
    }
    return items
  }, [user])

  return (
    <Layout className="kh-root">
      <Sider
        className="kh-sider"
        theme="dark"
        width={220}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        trigger={null}
      >
        <div className="kh-sider-logo" onClick={() => navigate('/dashboard')}>
          <BrandLogo />
          {!collapsed ? <span className="kh-logo-text">企业知识库</span> : null}
        </div>
        <Menu
          className="kh-side-menu"
          mode="inline"
          selectedKeys={selectedKeys}
          openKeys={collapsed ? [] : openKeys}
          onOpenChange={(keys) => setOpenKeys(keys.map(String))}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
        <div className="kh-sider-bottom" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          {!collapsed ? <span>收起菜单</span> : null}
        </div>
      </Sider>
      <Layout>
        <Header className="kh-header">
          <div className="kh-header-title">{sectionTitle}</div>
          <div className="kh-header-right">
            {isReviewer(user) ? (
              <Badge size="small" className="kh-bell">
                <BellOutlined
                  style={{ fontSize: 18, cursor: 'pointer' }}
                  onClick={() => navigate('/admin/reviews')}
                />
              </Badge>
            ) : null}
            <Dropdown
              menu={{
                items: [
                  ...(can(user, 'profile')
                    ? [
                        { key: 'profile', label: '个人中心' },
                        { type: 'divider' as const },
                      ]
                    : []),
                  { key: 'logout', label: '退出登录' },
                ],
                onClick: ({ key }) => {
                  if (key === 'profile') navigate('/profile')
                  if (key === 'logout') {
                    authApi.logout().catch(() => undefined)
                    clearAuth()
                    navigate('/login')
                  }
                },
              }}
            >
              <div className="kh-user">
                <Avatar size={28} icon={<UserOutlined />} src={user?.avatar || undefined} />
                <span>{displayName(user)}</span>
                {myTeams.slice(0, 2).map((team) => (
                  <Tag key={team.id} style={{ marginInlineEnd: 0 }}>
                    {team.teamName}
                  </Tag>
                ))}
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content className="kh-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
