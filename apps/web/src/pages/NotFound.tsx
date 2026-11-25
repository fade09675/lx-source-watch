import { Link } from 'react-router-dom';
import { EmptyState, PageHeader, SectionCard } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="NOT FOUND"
        title="页面不存在"
        description="你访问的地址不存在，或者已经被移动。"
        actions={
          <Link className="primary-button" to="/">
            返回工作台
          </Link>
        }
      />
      <SectionCard>
        <EmptyState
          icon="alert"
          title="找不到这个页面"
          description="请检查地址是否完整；从左侧导航重新进入对应页面。"
          action={<Link to="/">返回工作台</Link>}
        />
      </SectionCard>
    </div>
  );
}
