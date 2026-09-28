import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, App as AntdApp, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: '#2ea8ff',
          colorInfo: '#2ea8ff',
          colorBgBase: '#0b1120',
          colorBgLayout: '#0b1120',
          colorBgContainer: '#121c36',
          colorBgElevated: '#16214a',
          colorTextBase: '#dbe4f6',
          colorBorder: 'rgba(120, 160, 240, 0.30)',
          colorBorderSecondary: 'rgba(120, 160, 240, 0.16)',
          borderRadius: 8,
        },
        components: {
          Layout: {
            headerBg: 'transparent',
            siderBg: 'transparent',
            bodyBg: 'transparent',
            headerHeight: 56,
          },
          Menu: {
            itemBg: 'transparent',
            darkItemBg: 'transparent',
            darkSubMenuItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(46, 168, 255, 0.16)',
            darkItemSelectedColor: '#7cc7ff',
            darkItemColor: 'rgba(203, 216, 240, 0.68)',
            darkItemHoverColor: '#dbe4f6',
          },
          Table: {
            headerBg: 'rgba(30, 45, 82, 0.60)',
            rowHoverBg: 'rgba(46, 168, 255, 0.08)',
            borderColor: 'rgba(120, 160, 240, 0.14)',
          },
          Card: {},
          Modal: { contentBg: '#131d3c', headerBg: '#131d3c' },
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
)
