import copy
import io
import json
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import Request, urlopen

from malenia.google_sheets import GoogleSheetsConnector, GoogleSheetsError
from malenia.native_messaging import handle_message
from malenia.resources import ResourceManager
from malenia.server import MaleniaHTTPServer, make_handler
from malenia.store import TaskStore

BOOK = 'a' * 24
URL = f'https://docs.google.com/spreadsheets/d/{BOOK}/edit?gid=7'


class Response:
    status = 200
    def __init__(self, value): self.data = json.dumps(value).encode()
    def read(self, size): return self.data[:size]
    def __enter__(self): return self
    def __exit__(self, *args): pass


class SheetsAPI:
    """Stateful API fixture: real connector request/response shapes, no credentials."""
    def __init__(self):
        self.grid = [['Дата', 'Id заказа', 'main_partner', 'Стоимость', 'Наименование',
                      'Комментарий', 'Тикет', 'Статус', 'Группировка', 'впр']]
        for index in range(3):
            self.grid.append(['2026-10-03', f'ORDER-{index}', f'BOX-{index}', 100,
                              '=LOOKUP()', 'Keep comment', 'Keep ticket', '', 'Group', '=1'])
        self.colors = {}
        self.writes = []
        self.bad_verification = False
        self.other_gid = False

    def open(self, request, timeout=0):
        assert request.get_header('Authorization') == 'Bearer fixture'
        parsed = urlsplit(request.full_url)
        if request.get_method() == 'GET' and '/values/' not in parsed.path:
            return Response({'properties': {'title': 'ИНВента'}, 'sheets': [
                {'properties': {'sheetId': 8 if self.other_gid else 7, 'title': '03.10'}}]})
        if request.get_method() == 'GET':
            value_range = unquote(parsed.path.split('/values/')[1]).split('!')[1]
            if value_range == 'A:Z': return Response({'values': copy.deepcopy(self.grid)})
            match = re.fullmatch(r'H(\d+):H(\d+)', value_range)
            assert match, value_range
            return Response({'values': [[self.grid[row - 1][7]] for row in range(int(match[1]), int(match[2]) + 1)]})
        assert parsed.path.endswith(':batchUpdate')
        body = json.loads(request.data)
        self.writes.append(body)
        for operation in body['requests']:
            if 'updateCells' in operation:
                item = operation['updateCells']
                assert item['fields'] == 'userEnteredValue'
                area = item['range']
                assert area['sheetId'] == 7 and area['startColumnIndex'] == 7 and area['endColumnIndex'] == 8
                self.grid[area['startRowIndex']][7] = item['rows'][0]['values'][0]['userEnteredValue']['stringValue']
            else:
                item = operation['repeatCell']
                assert item['fields'] == 'userEnteredFormat.backgroundColorStyle'
                area = item['range']
                assert area['sheetId'] == 7 and area['startColumnIndex'] == 0 and area['endColumnIndex'] == 9
                self.colors[area['startRowIndex']] = item['cell']['userEnteredFormat']['backgroundColorStyle']['rgbColor']
        data = []
        for value_range in body['responseRanges']:
            row = int(re.search(r'!A(\d+):', value_range)[1]) - 1
            cells = [{'userEnteredValue': {'stringValue': str(value)}, 'userEnteredFormat': {
                'backgroundColorStyle': {'rgbColor': {} if self.bad_verification else self.colors[row]}}}
                for value in self.grid[row][:9]]
            data.append({'startRow': row, 'startColumn': 0, 'rowData': [{'values': cells}]})
        return Response({'updatedSpreadsheet': {'spreadsheetId': BOOK, 'sheets': [
            {'properties': {'sheetId': 7, 'title': '03.10'}, 'data': data}]}})


class AsgardSheetsAPI(SheetsAPI):
    def open(self, request, timeout=0):
        parsed = urlsplit(request.full_url)
        if request.get_method() == 'GET' and '/values/' in parsed.path:
            cell = unquote(parsed.path.split('/values/')[1]).split('!')[1]
            match = re.fullmatch(r'([A-Z])(\d+)', cell)
            if match:
                return Response({'values': [[self.grid[int(match[2])-1][ord(match[1])-65]]]})
        if request.get_method() == 'POST':
            body = json.loads(request.data)
            if all('updateCells' in x for x in body['requests']):
                self.writes.append(body)
                data = []
                for op in body['requests']:
                    area = op['updateCells']['range']
                    value = op['updateCells']['rows'][0]['values'][0]['userEnteredValue']['stringValue']
                    r, c = area['startRowIndex'], area['startColumnIndex']
                    self.grid[r][c] = value
                    data.append({'startRow': r, 'startColumn': c, 'rowData': [{'values': [{'userEnteredValue': {'stringValue': 'WRONG' if self.bad_verification else value}}]}]})
                return Response({'updatedSpreadsheet': {'spreadsheetId': BOOK, 'sheets': [
                    {'properties': {'sheetId': 7, 'title': '03.10'}, 'data': data}]}})
        return super().open(request, timeout)


class InventaWritebackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / 'db.sqlite')
        self.api = SheetsAPI()
        self.sheets = GoogleSheetsConnector(opener=self.api)
        self.sheets._access_token = 'fixture'
        self.sheets._access_expires_at = time.monotonic() + 3600
        self.server = MaleniaHTTPServer(('127.0.0.1', 0), make_handler(
            self.store, 'test-token', ResourceManager(), google_sheets=self.sheets))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()

    def queue(self, **extra):
        payload = {'spreadsheet_url': URL, 'mark_found': True, **extra}
        req = Request(f'http://127.0.0.1:{self.server.server_port}/v1/integrations/google-sheets/check-order-batch',
                      data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer test-token',
                      'Content-Type': 'application/json'})
        with urlopen(req) as response: result = json.load(response)
        self.assertEqual(result['write_enabled'], payload['mark_found'])
        return self.store.claim_browser_audit()

    def mark(self, job, scans=None):
        scans = scans if scans is not None else [
            ['BOX-0', '101366', 'OK', '2026-10-05 16:00:00'],
            ['BOX-1', '101366', 'OK', '2026-10-01 16:00:00'],
            ['BOX-2', '101366', 'OK', '2026-10-09 16:00:00']]
        return handle_message({'type': 'mark_inventa_found', 'request_id': 'fixture', 'job_id': job['job_id'],
            'inventory': job['inventory'], 'datalens': {
                'columns': ['main_partner_code_original', 'sc_id', 'result', 'scanned_at'], 'rows': scans}},
                self.store, google_sheets=self.sheets)

    def test_http_queue_native_mark_and_finish_preserve_other_cells_and_advance_only_after_verification(self):
        original = copy.deepcopy(self.api.grid)
        job = self.queue()
        self.assertTrue(job['writeback_required'])
        result = self.mark(job)
        self.assertEqual(result['written'], 2)
        self.assertTrue(result['verified'])
        for row in [1, 3]:
            self.assertEqual(self.api.grid[row][7], 'Найден')
            self.assertEqual(self.api.grid[row][:7], original[row][:7])
            self.assertEqual(self.api.grid[row][8:], original[row][8:])
        self.assertEqual(self.api.grid[2], original[2])
        self.assertEqual(len(self.api.writes), 1)
        self.assertEqual(self.mark(job)['written'], 2)  # acknowledged replay has no second network write
        self.assertEqual(len(self.api.writes), 1)
        self.assertTrue(self.store.claim_inventa_writeback(job['job_id'], asgard=True))
        self.assertTrue(self.store.complete_inventa_writeback(job['job_id'], 0, asgard=True))
        self.assertTrue(self.store.finish_browser_audit(job['job_id'], True))
        self.assertEqual(self.store.latest_browser_audit_job()['status'], 'completed')
        with self.store._session() as db:
            self.assertEqual(db.execute('SELECT next_offset FROM inventa_batch_cursor').fetchone()[0], 3)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM inventa_writeback').fetchone()[0], 0)

    def test_helper_lookup_columns_do_not_make_business_headers_ambiguous(self):
        self.api.grid[0].extend(['Статус', 'Партнер', 'Id заказа'])
        for row in self.api.grid[1:]: row.extend(['Helper status', 'Helper partner', 'Helper order'])
        original = copy.deepcopy(self.api.grid)
        job = self.queue()
        self.assertEqual(self.mark(job)['written'], 2)
        for index in range(1, 4): self.assertEqual(self.api.grid[index][9:], original[index][9:])

    def test_explicit_main_partner_wins_over_generic_partner(self):
        self.api.grid[0][2] = 'Партнер'
        self.api.grid[0][5] = 'main_partner'
        for index, row in enumerate(self.api.grid[1:]):
            row[5] = row[2]
            row[2] = f'SELLER-{index}'
        job = self.queue()
        self.assertEqual(job['inventory']['rows'][0][0], 'BOX-0')
        self.assertEqual(self.mark(job)['written'], 2)
        self.assertEqual(self.api.grid[1][2], 'SELLER-0')

    def test_two_status_columns_inside_business_block_still_stop_before_writes(self):
        from urllib.error import HTTPError
        self.api.grid[0][6] = 'Статус'
        with self.assertRaises(HTTPError) as caught: self.queue()
        response = json.load(caught.exception)
        self.assertEqual(response['error'], 'inventa_writeback_ambiguous_columns_status')
        self.assertEqual(self.api.writes, [])
        self.assertIsNone(self.store.latest_browser_audit_job())

    def test_new_ambiguous_header_added_during_audit_prevents_write(self):
        self.api.grid[0][8] = 'Unmapped column'
        job = self.queue()
        self.api.grid[0][8] = 'Статус'
        self.assertEqual(self.mark(job)['error'], 'inventa_writeback_source_changed')
        self.assertEqual(self.api.writes, [])

    def test_previous_read_only_cursor_does_not_skip_unmarked_rows(self):
        old = self.queue(mark_found=False)
        self.assertNotIn('writeback_required', old)
        self.store.finish_browser_audit(old['job_id'], True)
        marked = self.queue()
        self.assertEqual(marked['inventory']['rows'][0][0], 'BOX-0')
        self.assertTrue(marked['writeback_required'])

    def test_old_extension_cannot_complete_marking_job_without_writing(self):
        job = self.queue()
        self.store.finish_browser_audit(job['job_id'], True)
        self.assertEqual(self.store.latest_browser_audit_job()['status'], 'failed')
        self.assertEqual(self.store.latest_browser_audit_job()['failure_reason'], 'inventa_writeback_required')
        with self.store._session() as db:
            self.assertEqual(db.execute('SELECT next_offset FROM inventa_batch_cursor').fetchone()[0], 0)

    def test_sort_or_formula_or_changed_status_stops_before_remote_write(self):
        for mutation, expected in [
            (lambda: self.api.grid.__setitem__(slice(1, 3), self.api.grid[1:3][::-1]), 'inventa_writeback_source_changed'),
            (lambda: self.api.grid[1].__setitem__(7, '=IF(TRUE,"Найден","")'), 'inventa_writeback_formula_protected'),
            (lambda: self.api.grid[1].__setitem__(7, 'Manual change'), 'inventa_writeback_source_changed'),
            (lambda: self.api.grid[1].__setitem__(0, '2027-10-03'), 'inventa_writeback_source_changed')]:
            with self.subTest(expected=expected):
                self.api.grid = SheetsAPI().grid
                job = self.queue()
                mutation()
                self.assertEqual(self.mark(job)['error'], expected)
                self.assertEqual(self.api.writes, [])
                self.store.finish_browser_audit(job['job_id'], False)

    def test_unverified_remote_commit_is_retryable_without_corrupting_values(self):
        job = self.queue(); self.api.bad_verification = True
        self.assertEqual(self.mark(job)['error'], 'inventa_writeback_verification_failed')
        self.assertEqual(self.api.grid[1][7], 'Найден')
        self.api.bad_verification = False
        self.assertTrue(self.mark(job)['verified'])
        self.assertEqual(self.api.grid[1][4], '=LOOKUP()')
        self.assertEqual(self.api.grid[1][9], '=1')

    def test_forged_inventory_and_wrong_sheet_do_not_write(self):
        job = self.queue()
        forged = copy.deepcopy(job); forged['inventory']['rows'][0][0] = 'FOREIGN'
        self.assertFalse(self.mark(forged)['ok']); self.assertEqual(self.api.writes, [])
        self.api.other_gid = True
        self.assertFalse(self.mark(job)['ok']); self.assertEqual(self.api.writes, [])

    def test_only_old_or_failed_scans_do_not_mark_any_row(self):
        job = self.queue()
        result = self.mark(job, [['BOX-0', '101366', 'OK', '2026-10-01 16:00:00'],
                                 ['BOX-1', '101366', 'ERROR', '2026-10-05 16:00:00']])
        self.assertEqual(result['written'], 0)
        self.assertEqual(self.api.writes, [])
        self.assertTrue(self.store.finish_browser_audit(job['job_id'], True))

    def test_mark_requires_current_authorized_job_and_exact_message_shape(self):
        job = self.queue()
        self.store.cancel_browser_audit()
        self.assertFalse(self.mark(job)['ok'])
        self.assertEqual(self.api.writes, [])

    def test_concurrent_writer_is_rejected_and_reset_requires_same_running_job(self):
        job = self.queue()
        self.store.claim_inventa_writeback(job['job_id'])
        self.assertFalse(self.mark(job)['ok'])
        self.assertTrue(self.store.complete_inventa_writeback(job['job_id'], None))
        self.assertTrue(self.mark(job)['verified'])


class AsgardWritebackTests(unittest.TestCase):
    tearDown = InventaWritebackTests.tearDown
    queue = InventaWritebackTests.queue
    mark = InventaWritebackTests.mark
    # The end-to-end connector fixture handles both Found and Asgard writes.
    def setUp(self):
        InventaWritebackTests.setUp(self)
        self.api.__class__ = AsgardSheetsAPI

    def mark_asgard(self, job, status='В пути', destination='Склад ООО "Купишуз"', history=None, verification='card'):
        from malenia.asgard_outcomes import COLUMNS
        return handle_message({'type': 'mark_inventa_asgard', 'request_id': 'fixture', 'job_id': job['job_id'],
            'inventory': job['inventory'], 'datalens': {'columns': ['main_partner_code_original', 'sc_id', 'result', 'scanned_at'],
                'rows': [['BOX-0', '101366', 'OK', '2026-10-05 16:00:00'], ['BOX-2', '101366', 'OK', '2026-10-09 16:00:00']]},
            'asgard': {'columns': COLUMNS, 'rows': [['BOX-1', status, '' if verification in {'not_found', 'search_destination', 'issued_group'} else '123', destination,
                json.dumps(history if history is not None else ['В пути', 'Создан', 'Принят у отправителя']), verification]]}},
            self.store, google_sheets=self.sheets)

    def test_verified_kupishuz_card_marks_lamoda_and_comment_preserving_found_and_formulas(self):
        self.api.grid[2][5] = ''
        job = self.queue(); self.assertEqual(self.mark(job)['written'], 2)
        self.assertEqual(self.mark_asgard(job)['written'], 1)
        self.assertEqual(self.api.grid[2][7], 'Ламода')
        self.assertEqual(self.api.grid[2][5], 'Взять в работу')
        self.assertEqual(self.api.grid[1][7], 'Найден')
        self.assertEqual(self.api.grid[2][4], '=LOOKUP()')
        self.assertEqual(self.api.grid[2][9], '=1')
        count = len(self.api.writes)
        self.assertTrue(self.mark_asgard(job)['verified']); self.assertEqual(len(self.api.writes), count)
        self.store.finish_browser_audit(job['job_id'], True)
        self.assertEqual(self.store.latest_browser_audit_job()['status'], 'completed')

    def test_missing_search_and_non_lamoda_without_terminal_history_take_work(self):
        for missing in (True, False):
            self.api.grid[2][5] = ''; self.api.grid[2][7] = ''
            job = self.queue(); self.mark(job)
            result = self.mark_asgard(job, status='Не найден' if missing else 'В пути', destination='',
                                      history=[] if missing else ['Создан', 'В пути'], verification='not_found' if missing else 'card')
            self.assertTrue(result['ok'], result)
            self.assertEqual(self.api.grid[2][7], 'В работе'); self.assertEqual(self.api.grid[2][5], 'Взять в работу')
            self.store.finish_browser_audit(job['job_id'], True)
            with self.store._session() as db: db.execute('DELETE FROM inventa_batch_cursor')

    def test_asgard_cannot_complete_without_verification_or_overwrite_comment(self):
        job = self.queue(); self.mark(job)
        self.api.grid[2][5] = 'User edited comment'
        result = self.mark_asgard(job)
        self.assertEqual(result['error'], 'inventa_writeback_source_changed')
        self.assertEqual(self.api.grid[2][5], 'User edited comment')
        self.store.finish_browser_audit(job['job_id'], True)
        self.assertEqual(self.store.latest_browser_audit_job()['status'], 'failed')

    def test_ready_history_uses_exact_comment_and_migrates_old_automatic_marker(self):
        self.api.grid[2][5] = 'User note; 2 ШК Выдан'
        job = self.queue(); self.mark(job)
        ready = 'Готов для отгрузки в заборную логистику'
        result = self.mark_asgard(job, status=ready, destination='Другой склад', history=[ready, 'Выдан'])
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.api.grid[2][7], 'В работе')
        self.assertEqual(self.api.grid[2][5], 'User note; Два ШК Выдан')

    def test_kupishuz_search_shortcut_updates_status_without_needing_card_history(self):
        job = self.queue(); self.mark(job)
        result = self.mark_asgard(job, status='Купишуз', history=[], verification='search_destination')
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.api.grid[2][7], 'Ламода')
        self.assertEqual(self.api.grid[2][5], 'Keep comment')

    def test_all_remaining_issued_after_foreign_active_cards_marks_issued(self):
        job = self.queue(); self.mark(job)
        result = self.mark_asgard(job, status='Выдан', destination='', history=['В пути', 'Выдан'], verification='issued_group')
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.api.grid[2][7], 'Выдан')
        self.assertEqual(self.api.grid[2][5], 'Keep comment')

    def test_unverified_history_never_writes_and_asgard_requires_found_stage(self):
        job = self.queue()
        self.assertFalse(self.mark_asgard(job)['ok'])
        self.mark(job)
        self.assertFalse(self.mark_asgard(job, verification='generic_table')['ok'])
        self.assertEqual(self.api.grid[2][7], '')


if __name__ == '__main__': unittest.main()
