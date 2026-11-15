"""Decisions from the dedicated, identity-checked reverse-flow card adapter."""
import json
import re

COLUMNS = ['cargo_place', 'status', 'box_id', 'destination', 'history_json', 'verification']


def outcome(row):
    if not isinstance(row, list) or len(row) != len(COLUMNS) or any(not isinstance(x, str) for x in row):
        raise ValueError('invalid_asgard_evidence')
    cargo, status, box, destination, raw_history, verification = row
    history = json.loads(raw_history)
    if not isinstance(history, list) or not 0 <= len(history) <= 100 or any(not isinstance(x, str) or len(x) > 100 for x in history):
        raise ValueError('invalid_asgard_evidence')
    if verification == 'search_destination':
        if status != 'Купишуз' or box or history or not re.search('купишуз', destination, re.IGNORECASE):
            raise ValueError('invalid_asgard_evidence')
        return 'Ламода', None
    if verification == 'issued_group':
        active = {'В пути', 'Готов для отгрузки в заборную логистику'}
        if status != 'Выдан' or box or destination or 'Выдан' not in history or not active.intersection(history) or any(item not in active | {'Выдан'} for item in history):
            raise ValueError('invalid_asgard_evidence')
        return 'Выдан', None
    if verification == 'not_found':
        if status != 'Не найден' or box or destination or history:
            raise ValueError('invalid_asgard_evidence')
        return 'В работе', 'Взять в работу'
    if verification != 'card' or not re.fullmatch(r'\d{1,20}', box) or not history or status not in history:
        raise ValueError('invalid_asgard_evidence')
    if re.search('купишуз', destination, re.IGNORECASE):
        return 'Ламода', 'Взять в работу' if status in {'В пути', 'Готов для отгрузки в заборную логистику'} and not {'Выдан', 'Принят на ФФ'} & set(history) else None
    if status in {'В пути', 'Готов для отгрузки в заборную логистику'}:
        if 'Выдан' in history:
            return 'В работе', 'Два ШК Выдан'
        if 'Принят на ФФ' in history:
            return 'В работе', 'Два ШК Принят на ФФ'
        return 'В работе', 'Взять в работу'
    if status == 'Принят на ФФ':
        return 'В работе', 'Принят на ФФ'
    if status == 'Выдан':
        return 'Выдан', None
    return None
