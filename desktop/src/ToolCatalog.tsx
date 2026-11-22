import { ArrowUpRight, ClipboardList, Layers3 } from "lucide-react";

type ToolTarget = "sources" | "order_batch";
const tools = [
  {target:"sources", title:"Инвентаризация", description:"Проверить лист через DataLens и Asgard и сохранить результаты в Google Sheets.", icon:ClipboardList},
  {target:"order_batch", title:"Предпросмотр списка", description:"Вставить строки из Excel и посмотреть результат перед обработкой.", icon:Layers3},
] as const;

export function ToolCatalog({onOpen}:{onOpen:(target:ToolTarget)=>void}) {
  return <section className="page tool-catalog" aria-labelledby="tools-title">
    <div className="page-head"><h1 id="tools-title">Инструменты</h1></div>
    <div className="tool-list">{tools.map(tool=>
      <button key={tool.target} className="tool-row" onClick={()=>onOpen(tool.target)}>
        <span className="tool-icon"><tool.icon size={22}/></span>
        <span><strong>{tool.title}</strong><small>{tool.description}</small></span>
        <ArrowUpRight size={18}/>
      </button>
    )}</div>
  </section>;
}
