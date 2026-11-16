import { useState } from "react";
import { ArrowUpRight, BrainCircuit, Database, FileSearch, Layers3, Search, Sparkles } from "lucide-react";

export type ToolTarget = "sources" | "orders" | "order_batch" | "knowledge" | "skills";
type Category = "Все" | "Таблицы и заказы" | "Знания и навыки";
const tools = [
  { target:"sources", title:"Разбор ИНВенты", category:"Таблицы и заказы", badge:"Автоматическая проверка", description:"Проверить выбранный лист через DataLens и Asgard и сохранить подтверждённые результаты.", icon:Database },
  { target:"orders", title:"Проверка одного заказа", category:"Таблицы и заказы", badge:"Ручной ввод", description:"Разобрать один случай по введённым данным. Исходные системы и таблица не изменяются.", icon:FileSearch },
  { target:"order_batch", title:"Предпросмотр списка", category:"Таблицы и заказы", badge:"Без записи в источник", description:"Вставить строки из Excel и посмотреть результат проверки перед дальнейшей работой.", icon:Layers3 },
  { target:"knowledge", title:"Память и документы", category:"Знания и навыки", badge:"Локальные записи", description:"Сохранить полезные сведения, импортировать документы и найти информацию для ассистента.", icon:BrainCircuit },
  { target:"skills", title:"Навыки ассистента", category:"Знания и навыки", badge:"С вашим подтверждением", description:"Подготовить и проверить инструкции, которые помогают ассистенту решать повторяющиеся задачи.", icon:Sparkles },
] satisfies {target:ToolTarget;title:string;category:Category;badge:string;description:string;icon:typeof Database}[];
const categories:Category[]=["Все","Таблицы и заказы","Знания и навыки"];

export function ToolCatalog({onOpen}:{onOpen:(target:ToolTarget)=>void}) {
  const [query,setQuery]=useState("");
  const [category,setCategory]=useState<Category>("Все");
  const search=query.trim().toLocaleLowerCase("ru");
  const visible=tools.filter(tool=>(category==="Все"||tool.category===category)&&
    [tool.title,tool.description,tool.category].join(" ").toLocaleLowerCase("ru").includes(search));
  return <section className="page tool-catalog" aria-labelledby="tools-title">
    <div className="page-head"><div><div className="eyebrow">ВОЗМОЖНОСТИ МАЛЕНИИ</div><h1 id="tools-title">Инструменты</h1><p>Выберите инструмент для своей задачи. Здесь собраны доступные рабочие действия, знания и навыки.</p></div><span className="catalog-count">{tools.length} инструментов</span></div>
    <label className="catalog-search"><Search size={19}/><input aria-label="Поиск инструментов" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Какую задачу нужно решить?"/>{query?<button aria-label="Очистить поиск инструментов" onClick={()=>setQuery("")}>Сбросить</button>:null}</label>
    <div className="catalog-filters" role="group" aria-label="Категории инструментов">{categories.map(item=><button key={item} aria-pressed={category===item} onClick={()=>setCategory(item)}>{item}</button>)}</div>
    <div className="tool-grid">{visible.map(tool=><article className="panel tool-card" key={tool.target}>
      <div className="tool-card-top"><span className="tool-icon"><tool.icon size={22}/></span><span>{tool.badge}</span></div>
      <h2>{tool.title}</h2><p>{tool.description}</p><button className="tool-open" onClick={()=>onOpen(tool.target)} aria-label={"Открыть: "+tool.title}>Открыть инструмент <ArrowUpRight size={16}/></button>
    </article>)}</div>
    {!visible.length?<div className="work-empty" role="status"><Search size={24}/><b>Инструмент не найден</b><p>Попробуйте другое название или выберите категорию «Все».</p><button className="secondary" onClick={()=>{setQuery("");setCategory("Все");}}>Показать все инструменты</button></div>:null}
  </section>;
}
