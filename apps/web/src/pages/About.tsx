export function AboutPage() {
  return (
    <div className="page about">
      <h1>关于这个项目</h1>
      <p className="description">
        LX 音源监测定时在 GitHub Actions 里“模拟播放器”跑一遍音源脚本：初始化 → 逐平台取播放地址 → 实际拉取音频片段 → 校验返回的是不是音频。
        结果写成快照上报到 Cloudflare Worker，这里展示的是最近一轮的真实检测数据。
      </p>

      <h2>怎么看这些格子</h2>
      <ul className="about-list">
        <li>
          <strong>绿色</strong>：该平台取链成功，拉流返回了音频（显示的是总耗时）。
        </li>
        <li>
          <strong>红色</strong>：取链或拉流失败，悬停可看具体原因。
        </li>
        <li>
          <strong>灰色</strong>：没有对应测试曲或脚本没有声明该平台，属于“未测”，不等于不可用。
        </li>
        <li>源的整体状态：全部已测平台通过 = 可用；部分通过 = 部分可用；一个都没通过 = 不可用。</li>
      </ul>

      <h2>平台 key 说明</h2>
      <p className="description">
        LX Music 官方平台 key 是 kg（酷狗）、kw（酷我）、tx（QQ 音乐）、wy（网易云）、mg（咪咕）和 local（本地）。
        汽水、B 站、QQ SVIP 等属于第三方播放器扩展平台，本项目会按脚本声明动态展示，但不代表官方客户端一定能导入。
      </p>

      <h2>检测的局限</h2>
      <ul className="about-list">
        <li>Actions 运行在海外机房，国内平台可能因地域/风控误判；国内补测结果会单独列出，未配置代理时标“国内未测”。</li>
        <li>测试曲是固定的几首，版权下架或接口变更都会让结果变化；连续 3 轮全挂才会标记“持续失效”。</li>
        <li>云端网络与你的本地网络不同，最终能不能播，请以播放器实际播放为准。</li>
      </ul>

      <h2>导入方式</h2>
      <p className="description">
        在音源详情页点“复制导入链接”，粘贴到 LX Music 的自定义源导入框即可。远程源指向作者仓库的 latest.js，作者更新后你重新导入/更新订阅就能拿到新版本。
      </p>

      <h2>额度与实现</h2>
      <p className="description">
        重活全部在 GitHub Actions（公开仓库免费）；Cloudflare 只做只读展示：KV 存最新快照，D1 存 14 天明细与 180 天日汇总。
        每轮约 250 行 D1 写入、6 轮/天，远低于免费额度。源码以 MIT 协议公开。
      </p>

      <p className="muted small">本项目只做可用性检测，不托管、不修改任何第三方音源脚本；如有侵权或滥用，请通过仓库 issue 联系删除。</p>
    </div>
  );
}
