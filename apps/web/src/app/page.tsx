import { HomeView } from '@/components/home-view';
import { isLoginConfigured } from '@/server/auth';

export default function HomePage() {
  return <HomeView loginConfigured={isLoginConfigured()} />;
}
