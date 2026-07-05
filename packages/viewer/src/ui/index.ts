/**
 * viewer 内联 UI（最小 shadcn 风格组件集，Farsight 自持）。
 * 从原 @landing/ui 摘取 viewer 实际用到的组件；弹层 portal 直接挂 body
 * （原包的 portal-container 是宿主 MobileFrame 专用，此处不需要）。
 */
export { cn } from './cn';
export { Button, buttonVariants, type ButtonProps } from './button';
export { Input } from './input';
export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent } from './popover';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from './select';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export { Toaster, toast } from './sonner';
