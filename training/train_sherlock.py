"""Fine-tune your own Sherlock on an open model with LoRA (Unsloth).

Runs on a computer with an NVIDIA GPU (8+ GB VRAM) or in free Google Colab (T4).

    pip install unsloth
    python train_sherlock.py sherlock-YYYYMMDD.jsonl --base unsloth/Qwen3-8B

The dataset comes from Malenia: Память → Своя модель → «Выгрузить данные».
The result is a GGUF file and a Modelfile; import it into Ollama with
    ollama create sherlock -f sherlock-out/Modelfile
and pick "sherlock" in Malenia: Настройки → Модели ИИ → Локальная модель.
"""
import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset", help="JSONL exported from Malenia")
    parser.add_argument("--base", default="unsloth/Qwen3-8B",
                        help="Open base model from Hugging Face (Qwen3/Gemma/Llama in Unsloth format)")
    parser.add_argument("--out", default="sherlock-out")
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--max-seq", type=int, default=4096)
    parser.add_argument("--quant", default="q4_k_m", help="GGUF quantization for Ollama")
    args = parser.parse_args()

    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth import FastLanguageModel

    rows = [json.loads(line) for line in Path(args.dataset).read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(rows) < 50:
        print(f"Warning: only {len(rows)} examples. 200+ rated conversations give noticeably better results.")

    model, tokenizer = FastLanguageModel.from_pretrained(args.base, max_seq_length=args.max_seq, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=42)

    dataset = load_dataset("json", data_files=args.dataset, split="train")
    dataset = dataset.map(lambda row: {"text": tokenizer.apply_chat_template(row["messages"], tokenize=False)})

    trainer = SFTTrainer(model=model, tokenizer=tokenizer, train_dataset=dataset, args=SFTConfig(
        dataset_text_field="text", max_seq_length=args.max_seq, per_device_train_batch_size=2,
        gradient_accumulation_steps=4, num_train_epochs=args.epochs, learning_rate=2e-4, warmup_steps=5,
        logging_steps=5, optim="adamw_8bit", lr_scheduler_type="linear", output_dir=args.out + "/checkpoints",
        report_to="none"))
    trainer.train()

    out = Path(args.out)
    model.save_pretrained_gguf(str(out / "gguf"), tokenizer, quantization_method=args.quant)
    gguf = next(iter(sorted((out / "gguf").rglob("*.gguf"), key=lambda p: p.stat().st_size, reverse=True)), None)
    if gguf is None:
        raise SystemExit("GGUF file was not produced")
    system = rows[0]["messages"][0]["content"] if rows and rows[0]["messages"][0]["role"] == "system" else ""
    (out / "Modelfile").write_text(
        f'FROM ./{gguf.relative_to(out).as_posix()}\nPARAMETER temperature 0.4\nPARAMETER num_ctx 8192\n'
        + (f'SYSTEM """{system}"""\n' if system else ""), encoding="utf-8")
    print(f"Done. Import into Ollama:\n  cd {out}\n  ollama create sherlock -f Modelfile")


if __name__ == "__main__":
    main()
