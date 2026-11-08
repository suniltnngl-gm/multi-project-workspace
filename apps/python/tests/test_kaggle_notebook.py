import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.kaggle_run import prepare_run_directory, wait_for_completion


ROOT_DIR = Path(__file__).resolve().parents[3]
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-qwen-coder.ipynb"
PREP_NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-prepare-qwen-dataset.ipynb"
METADATA_PATH = ROOT_DIR / "notebooks" / "kernel-metadata.json"
RUNNER_PATH = ROOT_DIR / "scripts" / "kaggle_run.py"


class KaggleNotebookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
            cls.notebook = json.load(notebook_file)
        cls.cells_by_id = {
            cell.get("id"): "".join(cell.get("source", []))
            for cell in cls.notebook["cells"]
        }

    def test_notebook_code_cells_compile(self):
        cell_ids = [cell.get("id") for cell in self.notebook["cells"]]
        self.assertEqual(len(cell_ids), len(set(cell_ids)))
        code_cells = [
            cell for cell in self.notebook["cells"] if cell["cell_type"] == "code"
        ]
        self.assertTrue(code_cells)
        for index, cell in enumerate(code_cells):
            with self.subTest(cell=index, cell_id=cell.get("id")):
                compile("".join(cell["source"]), f"{NOTEBOOK_PATH}:cell {index}", "exec")

    def test_kaggle_runtime_and_single_gpu_configuration(self):
        sources = "\n".join(self.cells_by_id.values())
        paths = self.cells_by_id["kaggle-paths"]
        self.assertIn("datasets/edmundrosariosunil/qwen2-5-coder-3b-instruct", paths)
        self.assertIn("qwen2.5-coder-3b-instruct", paths)
        self.assertIn('INPUT_ROOT.rglob("config.json")', paths)
        self.assertIn("is_target_model_config(config)", paths)
        self.assertIn("len(matching_dirs) != 1", paths)
        self.assertNotIn("MODEL_DIR.mkdir", paths)
        self.assertIn('os.environ["HF_HOME"] = str(HF_HOME)', paths)
        self.assertIn('os.environ["HF_HUB_CACHE"] = str(HF_HOME / "hub")', paths)
        self.assertLess(paths.index('os.environ["HF_HOME"]'), paths.index("def is_target_model_config"))
        install = self.cells_by_id["kaggle-install"]
        self.assertIn('"huggingface_hub>=0.25.0,<1.0"', install)
        self.assertIn('"--upgrade"', install)
        self.assertIn('"--force-reinstall"', install)
        self.assertIn('"--cache-dir"', install)
        loading = self.cells_by_id["kaggle-load-model"]
        cell_ids = [cell.get("id") for cell in self.notebook["cells"]]
        self.assertLess(cell_ids.index("kaggle-paths"), cell_ids.index("kaggle-load-model"))
        self.assertEqual(loading.count("local_files_only=True"), 2)
        self.assertEqual(loading.count('cache_dir=str(HF_HOME / "hub")'), 2)
        self.assertNotIn("snapshot_download", sources)
        self.assertIn('device_map={"": 0}', sources)
        self.assertNotIn("google.colab", sources)
        self.assertNotIn("runtime.unassign", sources)
        self.assertIn("Stop Session", sources)
        self.assertNotIn("30 hours per week", sources)

    def test_benchmark_warms_before_timed_generation(self):
        benchmark = self.cells_by_id["kaggle-inference"]
        warmup = benchmark.index("max_new_tokens=1")
        synchronization = benchmark.index("torch.cuda.synchronize()", warmup)
        reset_peaks = benchmark.index("torch.cuda.reset_peak_memory_stats(0)")
        timer = benchmark.index("started = time.perf_counter()")
        timed_generation = benchmark.index("max_new_tokens=220")

        self.assertLess(warmup, synchronization)
        self.assertLess(synchronization, reset_peaks)
        self.assertLess(reset_peaks, timer)
        self.assertLess(timer, timed_generation)
        self.assertIn("torch.cuda.max_memory_allocated(0)", benchmark)
        self.assertIn("torch.cuda.max_memory_reserved(0)", benchmark)

    def test_batch_runner_exports_validated_response_and_metadata(self):
        response_cell = self.cells_by_id["kaggle-save-response"]
        cleanup_index = next(
            index
            for index, cell in enumerate(self.notebook["cells"])
            if cell.get("id") == "kaggle-cleanup"
        )
        response_index = next(
            index
            for index, cell in enumerate(self.notebook["cells"])
            if cell.get("id") == "kaggle-save-response"
        )
        self.assertLess(response_index, cleanup_index)
        self.assertIn('Path("/kaggle/working/response.json")', response_cell)
        self.assertIn("json.dumps(draft", response_cell)
        self.assertIn("validated model response", response_cell)

        with METADATA_PATH.open(encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
        self.assertEqual(
            metadata["dataset_sources"],
            ["edmundrosariosunil/qwen2-5-coder-3b-instruct"],
        )
        self.assertTrue(metadata["is_private"])
        self.assertTrue(metadata["enable_gpu"])
        compile(RUNNER_PATH.read_text(encoding="utf-8"), str(RUNNER_PATH), "exec")

        task = {
            "title": "A task with quotes: ' and \"",
            "project": "api",
            "task_type": "feature",
            "description": "Handle newlines\nand Unicode: café.",
            "acceptance_criteria": "Return a validated draft.",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            kernel_id, notebook_path = prepare_run_directory(
                task, Path(temporary_directory)
            )
            self.assertEqual(kernel_id, metadata["id"])
            with notebook_path.open(encoding="utf-8") as notebook_file:
                prepared = json.load(notebook_file)
            inference = next(
                cell
                for cell in prepared["cells"]
                if cell.get("id") == "kaggle-inference"
            )
            compile("".join(inference["source"]), "prepared inference cell", "exec")
            namespace = {}
            exec("".join(inference["source"]).split("messages =", 1)[0], namespace)
            self.assertEqual(namespace["task"], task)

    @patch("scripts.kaggle_run.time.sleep")
    @patch(
        "scripts.kaggle_run.run_kaggle",
        side_effect=[
            "KernelWorkerStatus.RUNNING",
            "KernelWorkerStatus.COMPLETE",
        ],
    )
    def test_batch_runner_waits_until_kernel_completes(self, run_kaggle, sleep):
        wait_for_completion("edmundrosariosunil/kaggle-qwen-coder", 60, 1)
        self.assertEqual(run_kaggle.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_cpu_dataset_prep_notebook_compiles_and_verifies_snapshot(self):
        with PREP_NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
            notebook = json.load(notebook_file)
        code_cells = [
            cell for cell in notebook["cells"] if cell["cell_type"] == "code"
        ]
        self.assertTrue(code_cells)
        for index, cell in enumerate(code_cells):
            with self.subTest(cell=index, cell_id=cell.get("id")):
                compile(
                    "".join(cell["source"]),
                    f"{PREP_NOTEBOOK_PATH}:cell {index}",
                    "exec",
                )
        sources = "\n".join(
            "".join(cell["source"]) for cell in notebook["cells"]
        )
        self.assertIn("/kaggle/working/qwen2.5-coder-3b-instruct", sources)
        self.assertIn("snapshot_download", sources)
        self.assertIn("config.json", sources)
        self.assertIn("*.safetensors", sources)
        self.assertNotIn("torch.cuda", sources)
        self.assertIn("private Kaggle Dataset", sources)


if __name__ == "__main__":
    unittest.main()
