import json
import unittest
from malenia.asgard_outcomes import outcome


class AsgardOutcomeTests(unittest.TestCase):
    def card(self, history, destination='Склад партнёра', status='В пути'):
        return ['TEST-1', status, '123', destination, json.dumps(history), 'card']

    def test_terminal_history_belongs_to_selected_card(self):
        self.assertEqual(outcome(self.card(['В пути', 'Выдан'])), ('В работе', '2 ШК Выдан'))
        self.assertEqual(outcome(self.card(['В пути', 'Принят на ФФ'])), ('В работе', '2 ШК Принят на ФФ'))
        self.assertEqual(outcome(self.card(['В пути', 'Принят у отправителя'])), ('В работе', 'Взять в работу'))

    def test_kupishuz_overrides_in_progress_and_issued_status(self):
        self.assertEqual(outcome(self.card(['В пути'], 'Склад ООО "Купишуз"')), ('Ламода', 'Взять в работу'))
        self.assertEqual(outcome(self.card(['Выдан'], 'Склад ООО "Купишуз"', 'Выдан')), ('Ламода', None))

    def test_missing_search_is_explicit_and_generic_history_is_rejected(self):
        self.assertEqual(outcome(['TEST-1', 'Не найден', '', '', '[]', 'not_found']), ('В работе', 'Взять в работу'))
        for row in [self.card([]), self.card(['Создан']), ['TEST-1','В пути','123','','["В пути"]','generic_table']]:
            with self.assertRaises(ValueError): outcome(row)
