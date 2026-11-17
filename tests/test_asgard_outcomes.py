import json
import unittest
from malenia.asgard_outcomes import outcome


class AsgardOutcomeTests(unittest.TestCase):
    def card(self, history, destination='Склад партнёра', status='В пути'):
        return ['TEST-1', status, '123', destination, json.dumps(history), 'card']

    def test_terminal_history_belongs_to_selected_card(self):
        self.assertEqual(outcome(self.card(['В пути', 'Выдан'])), ('В работе', 'Два ШК Выдан'))
        self.assertEqual(outcome(self.card(['В пути', 'Принят на ФФ'])), ('В работе', 'Два ШК Принят на ФФ'))
        self.assertEqual(outcome(self.card(['В пути', 'Принят у отправителя'])), ('В работе', 'Взять в работу'))

    def test_kupishuz_overrides_in_progress_and_issued_status(self):
        self.assertEqual(outcome(self.card(['В пути'], 'Склад ООО "Купишуз"')), ('Ламода', 'Взять в работу'))
        self.assertEqual(outcome(self.card(['Выдан'], 'Склад ООО "Купишуз"', 'Выдан')), ('Ламода', None))

    def test_missing_search_is_explicit_and_generic_history_is_rejected(self):
        self.assertEqual(outcome(['TEST-1', 'Не найден', '', '', '[]', 'not_found']), ('В работе', 'Взять в работу'))
        for row in [self.card([]), self.card(['Создан']), ['TEST-1','В пути','123','','["В пути"]','generic_table']]:
            with self.assertRaises(ValueError): outcome(row)

    def test_ready_for_pickup_uses_the_same_selected_card_history(self):
        status = 'Готов для отгрузки в заборную логистику'
        self.assertEqual(outcome(self.card([status, 'Выдан'], status=status)), ('В работе', 'Два ШК Выдан'))
        self.assertEqual(outcome(self.card([status, 'Принят на ФФ'], status=status)), ('В работе', 'Два ШК Принят на ФФ'))
        self.assertEqual(outcome(self.card([status, 'Создан'], status=status)), ('В работе', 'Взять в работу'))

    def test_uniform_destination_shortcut_needs_explicit_kupishuz_evidence(self):
        self.assertEqual(outcome(['TEST-1', 'Купишуз', '', 'Склад ООО "Купишуз"', '[]', 'search_destination']), ('Ламода', None))
        for row in [['TEST-1', 'Купишуз', '', 'Другой склад', '[]', 'search_destination'],
                    ['TEST-1', 'Купишуз', '', 'Купишуз', '["Выдан"]', 'search_destination']]:
            with self.assertRaises(ValueError): outcome(row)

    def test_foreign_active_cards_and_all_remaining_issued_use_explicit_group_evidence(self):
        self.assertEqual(outcome(['TEST-1', 'Выдан', '', '', '["В пути", "Выдан", "Выдан"]', 'issued_group']), ('Выдан', None))
        for statuses in [['В пути'], ['В пути', 'Создан', 'Выдан'], ['Выдан']]:
            with self.assertRaises(ValueError): outcome(['TEST-1', 'Выдан', '', '', json.dumps(statuses), 'issued_group'])

    def test_ready_for_customer_pickup_uses_explicit_owner_rule_not_issued(self):
        status = 'Готов для выдачи'
        for history in ([status, 'Прибыл в точку выдачи', 'В пути', 'Создан', 'Принят у отправителя'],
                        [status, 'Выдан'], [status, 'Принят на ФФ']):
            with self.subTest(history=history):
                self.assertEqual(outcome(self.card(history, status=status)), ('В работе', 'Взять в работу'))
        with self.assertRaises(ValueError):
            outcome(self.card(['Выдан'], status=status))

    def test_uniform_ff_search_group_uses_explicit_result_list_rule(self):
        for count in (1, 12, 20):
            row = ['TEST-1', 'Принят на ФФ', '', '', json.dumps(['Принят на ФФ'] * count), 'ff_search_group']
            self.assertEqual(outcome(row), ('В работе', 'Принят на ФФ'))
        for history in ([], ['Выдан'], ['Принят на ФФ', 'В пути'], ['Принят на ФФ'] * 21):
            with self.subTest(history=history):
                with self.assertRaises(ValueError):
                    outcome(['TEST-1', 'Принят на ФФ', '', '', json.dumps(history), 'ff_search_group'])
        for index, value in ((1, 'Выдан'), (2, '123'), (3, 'Купишуз')):
            row = ['TEST-1', 'Принят на ФФ', '', '', '["Принят на ФФ"]', 'ff_search_group']
            row[index] = value
            with self.assertRaises(ValueError): outcome(row)
