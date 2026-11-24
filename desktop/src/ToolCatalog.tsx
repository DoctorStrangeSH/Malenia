import { ArrowUpRight, ClipboardList } from "lucide-react";

type ToolTarget = "sources";
const tools = [
  {target:"sources", title:"Инвентаризация", description:"Сверить лист Google Sheets с DataLens и Asgard.", icon:ClipboardList},
] as const;

export function ToolCatalog({onOpen}:{onOpen:(target:ToolTarget)=>void}) {
  return <section className="page tool-catalog" aria-labelledby="tools-title">
    <div className="page-title"><h1 id="tools-title">Инструменты</h1><p>Рабочие сценарии, которые Маления выполняет в браузере и таблицах. Новые инструменты появятся здесь.</p></div>
    <div className="tool-list">{tools.map(tool=>
      <button key={tool.target} className="tool-row" onClick={()=>onOpen(tool.target)}>
        <span className="tool-icon"><tool.icon size={22}/></span>
        <span><strong>{tool.title}</strong><small>{tool.description}</small></span>
        <ArrowUpRight size={18}/>
      </button>
    )}</div>
  </section>;
}
