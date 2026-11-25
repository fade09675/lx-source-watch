import { PageHeader, SectionCard } from '../components/ui';

export function AboutPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="ABOUT"
        title="关于这个项目"
        description="定期在 GitHub Actions 里模拟播放器跑一遍音源脚本：初始化、逐平台取播放地址、实际拉取音频片段并校验内容；结果上报到 Cloudflare Worker，这里展示最近一轮的真实检测数据和历史记录。"
      />

      <div className="about-grid">
        <SectionCard title="怎么看结果" description="颜色和状态只代表本轮检测，不代表你的本地网络一定相同">
          <ul className="about-list">
            <li>
              <strong>绿色</strong>：该平台取链成功，拉流返回了音频，显示总耗时。
            </li>
            <li>
              <strong>红色</strong>：取链或拉流失败，详情里能看到具体错误。
            </li>
            <li>
              <strong>灰色</strong>：没有对应测试曲，或脚本没有声明该平台；这是“未测”，不等于不可用。
            </li>
            <li>源状态：全部已测平台通过为可用，部分通过为部分可用，全部失败为不可用。</li>
          </ul>
        </SectionCard>

        <SectionCard title="平台 key" description="官方平台与第三方扩展平台分开看">
          <p className="about-copy">
            LX Music 官方平台 key 是 kg（酷狗）、kw（酷我）、tx（QQ 音乐）、wy（网易云）、mg（咪咕）和 local（本地）。
          </p>
          <p className="about-copy">
            汽水、B 站、QQ SVIP 等属于第三方播放器扩展平台，本项目按脚本声明动态展示，但不代表官方客户端一定能导入。
          </p>
        </SectionCard>

        <SectionCard title="检测局限" description="云端结果只作参考，最终以播放器实际播放为准">
          <ul className="about-list">
            <li>Actions 运行在海外机房，国内平台可能因地域或风控误判；国内补测结果会单独标记。</li>
            <li>测试曲固定，版权下架或接口变更都会让结果变化；连续 3 轮全挂才会标记持续失效。</li>
            <li>国内补测只覆盖海外失败的播放地址，没有失败平台时显示“无需补测”。</li>
          </ul>
        </SectionCard>

        <SectionCard title="导入方式" description="远程源跟随作者更新，重新导入或更新订阅即可">
          <p className="about-copy">
            在音源详情页选择“推荐 / 主地址 / 镜像”，点“复制导入链接”，粘贴到 LX Music 的自定义源导入框。推荐地址会优先选可用且版本同步的线路。
          </p>
        </SectionCard>

        <SectionCard title="额度与实现" description="重活在 Actions，Cloudflare 只做展示">
          <ul className="about-list">
            <li>GitHub Actions 负责探测、国内补测、代理测活和自动发现，公开仓库不占私有分钟数。</li>
            <li>Cloudflare KV 存最新快照，D1 存运行明细、任务、测活与日汇总。</li>
            <li>额度护栏会在接近免费额度时暂停派发；运行记录可以在管理页预览后清理。</li>
            <li>源码以 MIT 协议公开，不改写、不托管第三方音源脚本。</li>
          </ul>
        </SectionCard>

        <SectionCard title="数据与隐私" description="单管理员站点，整站登录">
          <p className="about-copy">
            站点只保存检测结果、任务记录和代理配置；代理密码使用 AES-GCM 加密，密钥只存在于 Worker Secret。页面不加载第三方统计脚本。
          </p>
        </SectionCard>
      </div>

      <p className="muted small about-foot">
        本项目只做可用性检测，不托管、不修改任何第三方音源脚本；如有侵权或滥用，请通过仓库 issue 联系删除。
      </p>
    </div>
  );
}
