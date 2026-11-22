import {useEffect,useRef,type ReactNode} from "react";

export function WorkspaceDialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=ref.current;
    dialog?.showModal();
    return ()=>dialog?.close();
  },[]);
  return <dialog ref={ref} className="workspace-dialog" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}}>
    <header><h2>{title}</h2><button className="secondary" onClick={onClose} aria-label="Закрыть окно">Закрыть</button></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
