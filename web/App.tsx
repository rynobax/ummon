import { Review } from "./Review.tsx";
import { WorkspaceList } from "./WorkspaceList.tsx";

export function App() {
  const match = window.location.pathname.match(/^\/w\/([^/]+)/);
  return match ? <Review workspaceId={match[1]} /> : <WorkspaceList />;
}
