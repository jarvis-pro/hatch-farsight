import { Toaster as SonnerToaster, toast } from 'sonner';

/** 全局 toast 容器。 */
function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return (
    <SonnerToaster
      position="top-center"
      // Radix modal Dialog 打开时会把 body 设为 pointer-events:none，toaster 继承后 toast 收不到
      // 鼠标事件（hover 展开/点击失效）。子元素显式 auto 可覆盖祖先 none，使 toast 始终可交互。
      className="pointer-events-auto"
      toastOptions={{
        classNames: {
          toast: 'group rounded-lg border shadow-lg',
        },
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
